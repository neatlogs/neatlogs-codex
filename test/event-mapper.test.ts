import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NeatlogsConfig } from "../src/config";
import type { CodexHookPayload } from "../src/codex-events";
import { mapHookEvent, type TurnState } from "../src/event-mapper";
import { StateStore } from "../src/state-store";
import { bytesToHex, deterministicId, SpanStatusCode, type OtlpSpan } from "../src/trace-shipper";

const config: NeatlogsConfig = {
  apiKey: "test-key",
  endpoint: "https://ingest.example.test",
  userId: "tester",
  debug: false,
};

function attribute(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const value = span.attributes.find((candidate) => candidate.key === key)?.value;
  return value?.stringValue ?? value?.intValue ?? value?.doubleValue ?? value?.boolValue;
}

describe("mapHookEvent", () => {
  let runtimeRoot: string;
  let state: StateStore;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "neatlogs-codex-mapper-"));
    state = new StateStore(runtimeRoot);
  });

  afterEach(() => rmSync(runtimeRoot, { recursive: true, force: true }));

  function payload(
    hook_event_name: CodexHookPayload["hook_event_name"],
    patch: Partial<CodexHookPayload> = {},
  ): CodexHookPayload {
    return {
      session_id: "session-1",
      turn_id: "turn-1",
      hook_event_name,
      cwd: "/workspace",
      model: "gpt-5.6-codex",
      permission_mode: "default",
      ...patch,
    };
  }

  it("creates deterministic tool spans with measured duration and redaction", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Fix the failing test" }), config, state, 1_000);
    mapHookEvent(
      payload("PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "npm test", api_key: "should-not-leak" },
      }),
      config,
      state,
      1_100,
    );
    const result = mapHookEvent(
      payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "npm test", api_key: "should-not-leak" },
        tool_response: { exit_code: 0, output: "ok" },
      }),
      config,
      state,
      1_600,
    );

    expect(result.spans).toHaveLength(1);
    const [span] = result.spans;
    expect(span.name).toBe("Bash");
    expect(bytesToHex(span.traceId)).toBe(bytesToHex(deterministicId("codex:session-1:turn-1", 16)));
    expect(bytesToHex(span.parentSpanId!)).toBe(
      bytesToHex(deterministicId("codex:session-1:turn-1:root", 8)),
    );
    expect(attribute(span, "neatlogs.llm.metrics.duration_ms")).toBe("500");
    expect(attribute(span, "neatlogs.tool.input")).toContain("[redacted]");
    expect(attribute(span, "neatlogs.tool.input")).not.toContain("should-not-leak");
    expect(span.status?.code).toBe(SpanStatusCode.OK);
  });

  it("marks failed tool responses as errors", () => {
    const result = mapHookEvent(
      payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "failed-tool",
        tool_response: { exit_code: 2, output: "failed" },
      }),
      config,
      state,
      2_000,
    );

    expect(result.spans[0].status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "Tool exited with code 2",
    });
    expect(result.compatibilityEvents).toEqual([
      {
        name: "PostToolUseFailure",
        source: "PostToolUse",
        fidelity: "equivalent",
      },
    ]);
    expect(attribute(result.spans[0], "neatlogs.tool.output")).toContain("failed");
    expect(result.spans[0].attributes.some(({ key }) => key.startsWith("neatlogs.codex."))).toBe(false);
  });

  it("conditionally derives permission denial only from explicit approval evidence", () => {
    const denied = mapHookEvent(
      payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "denied-tool",
        tool_response: { success: false, error: "Approval request was denied by the user" },
      }),
      config,
      state,
      2_000,
    );
    expect(denied.compatibilityEvents?.map((event) => event.name)).toEqual([
      "PostToolUseFailure",
      "PermissionDenied",
    ]);
    expect(attribute(denied.spans[0], "error.message")).toBe(
      "Approval request was denied by the user",
    );
    expect(denied.spans[0].attributes.some(({ key }) => key.startsWith("neatlogs.codex."))).toBe(false);

    const filesystemError = mapHookEvent(
      payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "filesystem-tool",
        tool_response: { success: false, error: "EACCES: permission denied" },
      }),
      config,
      state,
      2_100,
    );
    expect(filesystemError.compatibilityEvents?.map((event) => event.name)).toEqual([
      "PostToolUseFailure",
    ]);
  });

  it("closes a turn with an LLM span, root span, and completion marker", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Explain this repository" }), config, state, 10_000);
    const result = mapHookEvent(
      payload("Stop", { last_assistant_message: "Here is the explanation." }),
      config,
      state,
      12_500,
    );

    expect(result.spans.map((span) => span.name)).toEqual([
      "gpt-5.6-codex",
      "Explain this repository",
      "neatlogs.trace.complete",
    ]);
    const root = result.spans[1];
    expect(attribute(result.spans[0], "neatlogs.input.value")).toBe("Explain this repository");
    expect(attribute(root, "neatlogs.span.kind")).toBe("WORKFLOW");
    expect(attribute(root, "neatlogs.input.value")).toBe("Explain this repository");
    expect(attribute(root, "neatlogs.output.value")).toBe("Here is the explanation.");
    expect(attribute(root, "neatlogs.session.id")).toBe("session-1");
    expect(attribute(root, "neatlogs.workflow_name")).toBe("Explain this repository");
    expect(
      state.read<TurnState>("session-1", "turn:turn-1")?.completed,
    ).toBe(true);
  });

  it("enriches LLM spans from the Codex transcript without duplicating root usage", () => {
    const transcriptPath = join(runtimeRoot, "rollout.jsonl");
    const transcript = [
      {
        timestamp: "2026-08-18T00:00:00.000Z",
        type: "session_meta",
        payload: {
          model_provider: "azure",
          source: "cli",
          cli_version: "0.148.0-alpha.9",
          originator: "codex-tui",
          git: {
            branch: "feature/tracing",
            commit_hash: "abc123",
            repository_url: "https://secret.example/repository.git",
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          started_at: 1_776_643_200,
          model_context_window: 200_000,
          collaboration_mode_kind: "default",
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.010Z",
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          approval_policy: "on-request",
          collaboration_mode: { mode: "plan" },
          sandbox_policy: { type: "workspace-write", network_access: false },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.100Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Reasoning summary" }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.200Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec" },
      },
      {
        timestamp: "2026-08-18T00:00:00.400Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 70,
              cache_write_input_tokens: 5,
              output_tokens: 25,
              reasoning_output_tokens: 10,
              total_tokens: 125,
            },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Finished" }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:01.200Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 80,
              output_tokens: 30,
              reasoning_output_tokens: 8,
              total_tokens: 150,
            },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
          last_agent_message: "Finished",
          duration_ms: 2_000,
          time_to_first_token_ms: 420,
        },
      },
    ];
    writeFileSync(transcriptPath, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    mapHookEvent(
      payload("SessionStart", { source: "startup", cwd: "/session-workspace" }),
      config,
      state,
      900,
    );
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Inspect the repository" }), config, state, 1_000);

    const result = mapHookEvent(
      payload("Stop", { transcript_path: transcriptPath, last_assistant_message: "Finished" }),
      config,
      state,
      3_000,
    );

    expect(result.spans.map((span) => span.name)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol",
      "Inspect the repository",
      "neatlogs.trace.complete",
    ]);
    const firstLLM = result.spans[0];
    expect(attribute(firstLLM, "neatlogs.llm.token_count.total")).toBe("125");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.prompt")).toBe("100");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.completion")).toBe("25");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.reasoning")).toBe("10");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.cache_read")).toBe("70");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.cached")).toBe("70");
    expect(attribute(firstLLM, "neatlogs.llm.token_count.cache_write")).toBe("5");
    expect(attribute(firstLLM, "neatlogs.llm.effort_level")).toBe("xhigh");
    expect(attribute(firstLLM, "neatlogs.llm.thinking")).toBe("Reasoning summary");
    expect(attribute(firstLLM, "neatlogs.llm.has_thinking")).toBe("true");
    expect(attribute(firstLLM, "neatlogs.llm.tool_calls")).toBe("Bash");
    expect(attribute(firstLLM, "neatlogs.input.value")).toBe("Inspect the repository");
    expect(attribute(firstLLM, "neatlogs.llm.metrics.time_to_first_token")).toBe(420);
    expect(attribute(firstLLM, "neatlogs.llm.provider")).toBe("azure");
    expect(attribute(firstLLM, "neatlogs.workflow.effort_level")).toBe("xhigh");
    expect(attribute(firstLLM, "neatlogs.workflow.model_context_window")).toBe("200000");
    expect(attribute(firstLLM, "neatlogs.workflow.time_to_first_token_ms")).toBe("420");
    for (const rootOnlyKey of [
      "neatlogs.workflow.cwd",
      "neatlogs.workflow.permission_mode",
      "neatlogs.workflow.approval_policy",
      "neatlogs.workflow.collaboration_mode",
      "neatlogs.workflow.sandbox_mode",
      "neatlogs.workflow.network_access",
      "neatlogs.workflow.turn_status",
      "neatlogs.session.client",
      "neatlogs.session.cli_version",
      "neatlogs.session.originator",
      "neatlogs.session.git.branch",
      "neatlogs.session.git.commit",
    ]) {
      expect(attribute(firstLLM, rootOnlyKey)).toBeUndefined();
    }
    const root = result.spans[2];
    expect(attribute(root, "neatlogs.output.value")).toBe("Finished");
    expect(attribute(root, "neatlogs.llm.metrics.duration_ms")).toBe("2000");
    expect(attribute(root, "neatlogs.llm.provider")).toBe("azure");
    expect(attribute(root, "neatlogs.workflow.approval_policy")).toBe("on-request");
    expect(attribute(root, "neatlogs.workflow.model_context_window")).toBe("200000");
    expect(attribute(root, "neatlogs.workflow.collaboration_mode")).toBe("plan");
    expect(attribute(root, "neatlogs.workflow.sandbox_mode")).toBe("workspace-write");
    expect(attribute(root, "neatlogs.workflow.network_access")).toBe(false);
    expect(attribute(root, "neatlogs.workflow.permission_mode")).toBe("default");
    expect(attribute(root, "neatlogs.workflow.cwd")).toBe("/workspace");
    expect(attribute(root, "neatlogs.workflow.time_to_first_token_ms")).toBe("420");
    expect(attribute(root, "neatlogs.workflow.turn_status")).toBe("ok");
    expect(attribute(root, "neatlogs.session.start_source")).toBe("startup");
    expect(attribute(root, "neatlogs.session.client")).toBe("cli");
    expect(attribute(root, "neatlogs.session.cli_version")).toBe("0.148.0-alpha.9");
    expect(attribute(root, "neatlogs.session.originator")).toBe("codex-tui");
    expect(attribute(root, "neatlogs.session.git.branch")).toBe("feature/tracing");
    expect(attribute(root, "neatlogs.session.git.commit")).toBe("abc123");
    expect(JSON.stringify(result.spans)).not.toContain("secret.example");
    expect(JSON.stringify(result.spans)).not.toContain("rollout.jsonl");
    expect(root.attributes.some(({ key }) => key.startsWith("neatlogs.llm.token_count."))).toBe(false);
  });

  it("gives every transcript LLM phase meaningful input and output", () => {
    const transcriptPath = join(runtimeRoot, "multi-phase-rollout.jsonl");
    const transcript = [
      {
        timestamp: "2026-08-18T00:00:00.000Z",
        type: "session_meta",
        payload: { model_provider: "openai" },
      },
      {
        timestamp: "2026-08-18T00:00:00.010Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        timestamp: "2026-08-18T00:00:00.020Z",
        type: "turn_context",
        payload: { turn_id: "turn-1", model: "gpt-5.6-sol" },
      },
      {
        timestamp: "2026-08-18T00:00:00.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I’ll make the request." }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.200Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", call_id: "call-1" },
      },
      {
        timestamp: "2026-08-18T00:00:00.300Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: { exit_code: 6, output: "Could not resolve host" },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.310Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.400Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [], encrypted_content: "never-export" },
      },
      {
        timestamp: "2026-08-18T00:00:00.500Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", call_id: "call-2" },
      },
      {
        timestamp: "2026-08-18T00:00:00.600Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: { exit_code: 0, output: "HTTP/2 200" },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.610Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              output_tokens: 15,
              reasoning_output_tokens: 8,
              total_tokens: 135,
            },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.700Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "HTTP status: 200 OK." }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.710Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 140, output_tokens: 8, total_tokens: 148 },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.720Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-1" },
      },
    ];
    writeFileSync(transcriptPath, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Check the HTTP status" }), config, state, 1_000);

    const result = mapHookEvent(
      payload("Stop", { transcript_path: transcriptPath }),
      config,
      state,
      2_000,
    );
    const llmSpans = result.spans.filter(
      (span) => attribute(span, "neatlogs.span.kind") === "LLM",
    );

    expect(llmSpans).toHaveLength(3);
    expect(attribute(llmSpans[0], "neatlogs.input.value")).toBe("Check the HTTP status");
    expect(attribute(llmSpans[0], "neatlogs.output.value")).toBe("I’ll make the request.");
    expect(attribute(llmSpans[1], "neatlogs.input.value")).toContain("Could not resolve host");
    expect(attribute(llmSpans[1], "neatlogs.output.value")).toBe("Tool calls requested: Bash");
    expect(attribute(llmSpans[2], "neatlogs.input.value")).toContain("HTTP/2 200");
    expect(attribute(llmSpans[2], "neatlogs.output.value")).toBe("HTTP status: 200 OK.");
    expect(JSON.stringify(llmSpans)).not.toContain("never-export");
  });

  it("uses SessionEnd as a fallback for an unfinished turn", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Interrupted turn" }), config, state, 5_000);
    const result = mapHookEvent(
      {
        session_id: "session-1",
        hook_event_name: "SessionEnd",
        reason: "other",
      },
      config,
      state,
      6_000,
    );

    expect(result.cleanupSession).toBe(true);
    expect(result.spans.map((span) => span.name)).toEqual([
      "Interrupted turn",
      "neatlogs.trace.complete",
      "session_end",
    ]);
    expect(attribute(result.spans[0], "neatlogs.session.end_reason")).toBe("other");
    expect(attribute(result.spans[0], "neatlogs.workflow.turn_status")).toBe("incomplete");
    expect(attribute(result.spans[2], "neatlogs.session.end_reason")).toBe("other");
  });

  it("marks transcript turn failures and redacts error secrets", () => {
    const transcriptPath = join(runtimeRoot, "failed-rollout.jsonl");
    writeFileSync(
      transcriptPath,
      `${[
        {
          timestamp: "2026-08-18T00:00:00.000Z",
          type: "session_meta",
          payload: { model_provider: "openai" },
        },
        {
          timestamp: "2026-08-18T00:00:00.100Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        },
        {
          timestamp: "2026-08-18T00:00:00.200Z",
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "gpt-5.6-sol" },
        },
        {
          timestamp: "2026-08-18T00:00:00.300Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
            error: { message: "Model request failed", api_key: "do-not-export" },
          },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Fail safely" }), config, state, 1_000);

    const result = mapHookEvent(
      payload("Stop", { transcript_path: transcriptPath }),
      config,
      state,
      1_500,
    );
    const root = result.spans.at(-2)!;

    expect(root.status?.code).toBe(SpanStatusCode.ERROR);
    expect(attribute(root, "neatlogs.workflow.turn_status")).toBe("error");
    expect(attribute(root, "neatlogs.workflow.turn_error")).toContain("Model request failed");
    expect(attribute(root, "neatlogs.workflow.turn_error")).not.toContain("api_key");
    expect(JSON.stringify(root)).not.toContain("do-not-export");
  });

  it("records SessionEnd reason on a completed turn without creating another trace", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Complete normally" }), config, state, 1_000);
    const stopped = mapHookEvent(
      payload("Stop", { last_assistant_message: "Done" }),
      config,
      state,
      1_500,
    );
    const ended = mapHookEvent(
      { session_id: "session-1", hook_event_name: "SessionEnd", reason: "exit" },
      config,
      state,
      1_600,
    );

    expect(ended.spans).toHaveLength(1);
    expect(ended.spans[0].name).toBe("session_end");
    expect(bytesToHex(ended.spans[0].traceId)).toBe(bytesToHex(stopped.spans[0].traceId));
    expect(attribute(ended.spans[0], "neatlogs.session.end_reason")).toBe("exit");
  });

  it("maps permission, compaction, and subagent lifecycle events", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Delegate and compact" }), config, state, 1_000);

    const permission = mapHookEvent(
      payload("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "npm publish" },
      }),
      config,
      state,
      1_100,
    );
    expect(attribute(permission.spans[0], "neatlogs.tool.output")).toBe("Permission requested");

    const before = mapHookEvent(
      payload("PreCompact", { trigger: "auto" }),
      config,
      state,
      1_200,
    );
    const after = mapHookEvent(
      payload("PostCompact", { trigger: "auto" }),
      config,
      state,
      1_300,
    );
    expect(before.spans[0].name).toBe("context_compaction_before");
    expect(after.spans[0].name).toBe("context_compaction_after");
    expect(attribute(before.spans[0], "neatlogs.input.value")).toBe("auto");
    expect(attribute(before.spans[0], "neatlogs.output.value")).toBe("before");
    expect(attribute(after.spans[0], "neatlogs.output.value")).toBe("after");

    const started = mapHookEvent(
      payload("SubagentStart", {
        turn_id: "agent-turn",
        agent_id: "agent-1",
        agent_type: "reviewer",
      }),
      config,
      state,
      1_400,
    );
    expect(started.spans[0].name).toBe("TaskCreated");
    expect(started.compatibilityEvents?.[0].name).toBe("TaskCreated");
    expect(attribute(started.spans[0], "neatlogs.span.kind")).toBe("WORKFLOW");
    expect(attribute(started.spans[0], "neatlogs.workflow_name")).toBe("reviewer");
    expect(attribute(started.spans[0], "neatlogs.task_id")).toBe("agent-1");
    expect(attribute(started.spans[0], "neatlogs.output.value")).toBe("Task created");
    expect(bytesToHex(started.spans[0].traceId)).toBe(
      bytesToHex(deterministicId("codex:session-1:turn-1", 16)),
    );
    const agentTranscriptPath = join(runtimeRoot, "agent-rollout.jsonl");
    const agentTranscript = [
      {
        timestamp: "2026-08-18T00:00:00.000Z",
        type: "session_meta",
        payload: { model_provider: "azure", source: "subagent" },
      },
      {
        timestamp: "2026-08-18T00:00:00.100Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "agent-turn", started_at: 1_400 },
      },
      {
        timestamp: "2026-08-18T00:00:00.110Z",
        type: "turn_context",
        payload: { turn_id: "agent-turn", model: "gpt-agent", effort: "high" },
      },
      {
        timestamp: "2026-08-18T00:00:00.200Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Agent reasoning" }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.400Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "agent-tool-1",
          input: { command: "pwd" },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.450Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "agent-tool-1",
          output: { exit_code: 0, output: "/workspace" },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.480Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Review complete" }],
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.500Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 4,
              total_tokens: 60,
            },
          },
        },
      },
      {
        timestamp: "2026-08-18T00:00:00.600Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "agent-turn",
          last_agent_message: "Review complete",
          duration_ms: 500,
        },
      },
    ];
    writeFileSync(
      agentTranscriptPath,
      `${agentTranscript.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    const stopped = mapHookEvent(
      payload("SubagentStop", {
        turn_id: "agent-turn",
        agent_id: "agent-1",
        agent_type: "reviewer",
        agent_transcript_path: agentTranscriptPath,
        stop_hook_active: true,
        last_assistant_message: "Review complete",
      }),
      config,
      state,
      1_900,
    );
    expect(stopped.spans[0].name).toBe("reviewer");
    expect(attribute(stopped.spans[0], "neatlogs.span.kind")).toBe("AGENT");
    expect(attribute(stopped.spans[0], "neatlogs.llm.metrics.duration_ms")).toBe("500");
    expect(stopped.compatibilityEvents?.[0].name).toBe("TaskCompleted");
    expect(attribute(stopped.spans[0], "neatlogs.task_id")).toBe("agent-1");
    expect(attribute(stopped.spans[0], "neatlogs.output.value")).toBe("Review complete");
    expect(attribute(stopped.spans[0], "neatlogs.llm.model_name")).toBe("gpt-agent");
    expect(attribute(stopped.spans[0], "neatlogs.llm.provider")).toBe("azure");
    expect(attribute(stopped.spans[0], "neatlogs.llm.effort_level")).toBe("high");
    expect(attribute(stopped.spans[0], "neatlogs.workflow.stop_hook_active")).toBe(true);
    expect(stopped.spans[1].name).toBe("gpt-agent");
    expect(bytesToHex(stopped.spans[1].parentSpanId!)).toBe(bytesToHex(stopped.spans[0].spanId));
    expect(attribute(stopped.spans[1], "neatlogs.llm.token_count.total")).toBe("60");
    expect(attribute(stopped.spans[1], "neatlogs.llm.token_count.reasoning")).toBe("4");
    expect(attribute(stopped.spans[1], "neatlogs.llm.thinking")).toBe("Agent reasoning");
    expect(attribute(stopped.spans[1], "neatlogs.input.value")).toBe("reviewer");
    expect(stopped.spans[2].name).toBe("Bash");
    expect(bytesToHex(stopped.spans[2].parentSpanId!)).toBe(bytesToHex(stopped.spans[0].spanId));
    expect(attribute(stopped.spans[2], "neatlogs.span.kind")).toBe("TOOL");
    expect(attribute(stopped.spans[2], "neatlogs.tool.input")).toContain("pwd");
    expect(attribute(stopped.spans[2], "neatlogs.tool.output")).toContain("/workspace");
    expect(bytesToHex(stopped.spans[0].traceId)).toBe(
      bytesToHex(deterministicId("codex:session-1:turn-1", 16)),
    );
    expect(state.read<TurnState>("session-1", "turn:agent-turn")).toBeUndefined();
    for (const child of [stopped.spans[0], stopped.spans[1], stopped.spans[2]]) {
      expect(attribute(child, "neatlogs.workflow.cwd")).toBeUndefined();
      expect(attribute(child, "neatlogs.workflow.permission_mode")).toBeUndefined();
      expect(attribute(child, "neatlogs.workflow.approval_policy")).toBeUndefined();
      expect(attribute(child, "neatlogs.workflow.collaboration_mode")).toBeUndefined();
      expect(attribute(child, "neatlogs.workflow.sandbox_mode")).toBeUndefined();
      expect(attribute(child, "neatlogs.workflow.network_access")).toBeUndefined();
      expect(attribute(child, "neatlogs.session.client")).toBeUndefined();
      expect(attribute(child, "neatlogs.session.originator")).toBeUndefined();
    }
    expect(JSON.stringify(stopped.spans)).not.toContain("agent-rollout.jsonl");
  });

  it("uses established Neatlogs semantic attributes instead of Codex-only span fields", () => {
    mapHookEvent(payload("UserPromptSubmit", { prompt: "Inspect semantics" }), config, state, 1_000);
    const results = [
      mapHookEvent(
        payload("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm test" } }),
        config,
        state,
        1_100,
      ),
      mapHookEvent(payload("PreCompact", { trigger: "manual" }), config, state, 1_200),
      mapHookEvent(
        payload("SubagentStart", { agent_id: "agent-2", agent_type: "worker" }),
        config,
        state,
        1_300,
      ),
    ];

    const keys = results.flatMap((result) => result.spans.flatMap((span) => span.attributes.map(({ key }) => key)));
    expect(keys.some((key) => key.startsWith("neatlogs.codex."))).toBe(false);
    expect(keys).not.toContain("neatlogs.turn.id");
    expect(keys).not.toContain("neatlogs.task.id");
    expect(keys).not.toContain("neatlogs.task.status");
    expect(keys).toContain("neatlogs.workflow_name");
    expect(keys).toContain("neatlogs.task_id");
  });
});
