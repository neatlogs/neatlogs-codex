import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectCodexTranscriptSession,
  parseCodexTranscript,
} from "../src/transcript";

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

describe("parseCodexTranscript", () => {
  let directory: string;
  let transcriptPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "neatlogs-codex-transcript-"));
    transcriptPath = join(directory, "rollout.jsonl");
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("extracts only the requested turn's phases, usage, effort, reasoning, and timing", () => {
    const entries = [
      line("2026-08-18T00:00:00.000Z", "session_meta", {
        model_provider: "azure",
        source: "cli",
        cli_version: "0.148.0-alpha.9",
        originator: "codex-tui",
        base_instructions: "private instructions",
        git: {
          branch: "feature/tracing",
          commit_hash: "abc123",
          repository_url: "https://secret.example/repository.git",
        },
      }),
      line("2026-08-18T00:00:01.000Z", "event_msg", {
        type: "task_started",
        turn_id: "old-turn",
        started_at: 1_776_643_201,
      }),
      line("2026-08-18T00:00:01.010Z", "turn_context", {
        turn_id: "old-turn",
        model: "gpt-old",
        effort: "low",
      }),
      line("2026-08-18T00:00:02.000Z", "event_msg", {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 999, output_tokens: 1, total_tokens: 1_000 } },
      }),
      line("2026-08-18T00:01:00.000Z", "event_msg", {
        type: "task_started",
        turn_id: "turn-2",
        started_at: 1_776_643_260,
        model_context_window: 200_000,
        collaboration_mode_kind: "default",
      }),
      line("2026-08-18T00:01:00.010Z", "turn_context", {
        turn_id: "turn-2",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        approval_policy: "on-request",
        collaboration_mode: { mode: "plan" },
        sandbox_policy: { type: "workspace-write", network_access: false },
      }),
      line("2026-08-18T00:01:00.100Z", "response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "I should inspect the repository." }],
      }),
      line("2026-08-18T00:01:00.200Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll inspect it." }],
      }),
      line("2026-08-18T00:01:00.300Z", "response_item", {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: { cmd: "pwd" },
      }),
      line("2026-08-18T00:01:00.350Z", "response_item", {
        type: "function_call_output",
        call_id: "call-1",
        output: { exit_code: 0, output: "/workspace" },
      }),
      line("2026-08-18T00:01:00.400Z", "event_msg", {
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
          model_context_window: 200_000,
        },
      }),
      "{partially-written",
      line("2026-08-18T00:01:01.000Z", "response_item", {
        type: "reasoning",
        summary: [],
        encrypted_content: "not-exported",
      }),
      line("2026-08-18T00:01:01.300Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Final answer" }],
      }),
      line("2026-08-18T00:01:01.400Z", "event_msg", {
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
      }),
      line("2026-08-18T00:01:02.000Z", "event_msg", {
        type: "task_complete",
        turn_id: "turn-2",
        last_agent_message: "Final answer",
        duration_ms: 2_000,
        time_to_first_token_ms: 420,
      }),
    ];
    writeFileSync(transcriptPath, `${entries.join("\n")}\n`);

    const summary = parseCodexTranscript(transcriptPath, "turn-2");

    expect(summary).toMatchObject({
      turnId: "turn-2",
      model: "gpt-5.6-sol",
      modelProvider: "azure",
      effort: "xhigh",
      approvalPolicy: "on-request",
      modelContextWindow: 200_000,
      collaborationMode: "plan",
      sandboxMode: "workspace-write",
      networkAccess: false,
      sessionSource: "cli",
      cliVersion: "0.148.0-alpha.9",
      originator: "codex-tui",
      gitBranch: "feature/tracing",
      gitCommit: "abc123",
      turnStatus: "ok",
      lastAssistantMessage: "Final answer",
      durationMs: 2_000,
      timeToFirstTokenMs: 420,
    });
    expect(summary?.phases).toHaveLength(2);
    expect(summary?.phases[0]).toMatchObject({
      text: "I’ll inspect it.",
      reasoningSummary: "I should inspect the repository.",
      toolCalls: ["exec_command"],
      hasReasoning: true,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 70,
        cacheWriteInputTokens: 5,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125,
      },
    });
    expect(summary?.phases[1].text).toBe("Final answer");
    expect(summary?.phases[1].reasoningSummary).toBe("");
    expect(summary?.phases[1].hasReasoning).toBe(true);
    expect(summary?.phases[0].inputs).toEqual([]);
    expect(summary?.phases[1].inputs).toEqual([{ exit_code: 0, output: "/workspace" }]);
    expect(summary?.toolCalls).toEqual([
      {
        callId: "call-1",
        name: "exec_command",
        input: { cmd: "pwd" },
        output: { exit_code: 0, output: "/workspace" },
        startMs: Date.parse("2026-08-18T00:01:00.300Z"),
        endMs: Date.parse("2026-08-18T00:01:00.350Z"),
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain("not-exported");
    expect(JSON.stringify(summary)).not.toContain("private instructions");
    expect(JSON.stringify(summary)).not.toContain("secret.example");
  });

  it("captures a completed turn error without reading unrelated transcript data", () => {
    writeFileSync(
      transcriptPath,
      `${[
        line("2026-08-18T00:00:00.000Z", "session_meta", { model_provider: "openai" }),
        line("2026-08-18T00:00:01.000Z", "event_msg", {
          type: "task_started",
          turn_id: "failed-turn",
        }),
        line("2026-08-18T00:00:01.100Z", "turn_context", {
          turn_id: "failed-turn",
          model: "gpt-5.6-sol",
        }),
        line("2026-08-18T00:00:01.200Z", "event_msg", {
          type: "task_complete",
          turn_id: "failed-turn",
          error: { message: "Model request failed", api_key: "must-not-be-emitted" },
        }),
      ].join("\n")}\n`,
    );

    const summary = parseCodexTranscript(transcriptPath, "failed-turn");

    expect(summary?.turnStatus).toBe("error");
    expect(summary?.turnError).toEqual({
      message: "Model request failed",
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-be-emitted");
  });

  it("returns undefined when the transcript does not exist", () => {
    expect(parseCodexTranscript(join(directory, "missing.jsonl"), "turn-1")).toBeUndefined();
  });

  it("classifies subagent transcripts without exposing their transcript contents", () => {
    writeFileSync(
      transcriptPath,
      `${line("2026-08-18T00:00:00.000Z", "session_meta", {
        id: "agent-thread",
        session_id: "parent-session",
        parent_thread_id: "parent-thread",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { agent_path: "/root/reviewer" } } },
      })}\n`,
    );

    expect(inspectCodexTranscriptSession(transcriptPath)).toEqual({
      threadId: "agent-thread",
      parentThreadId: "parent-thread",
      threadSource: "subagent",
      isSubagent: true,
    });
  });
});
