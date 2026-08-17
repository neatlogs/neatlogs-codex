import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NeatlogsConfig } from "../src/config";
import type { CodexHookPayload } from "../src/codex-events";
import { mapHookEvent } from "../src/event-mapper";
import { StateStore } from "../src/state-store";

const CLAUDE_PACKAGE_SEMANTIC_ATTRIBUTES = new Set([
  "error.message",
  "neatlogs.agent.name",
  "neatlogs.agent_id",
  "neatlogs.input.value",
  "neatlogs.llm.metrics.duration_ms",
  "neatlogs.llm.model_name",
  "neatlogs.llm.provider",
  "neatlogs.llm.request_type",
  "neatlogs.output.value",
  "neatlogs.session.id",
  "neatlogs.span.kind",
  "neatlogs.task_id",
  "neatlogs.tool.input",
  "neatlogs.tool.name",
  "neatlogs.tool.output",
  "neatlogs.tool_call.id",
  "neatlogs.user_id",
  "neatlogs.workflow_name",
]);

const config: NeatlogsConfig = {
  apiKey: "test-key",
  endpoint: "https://ingest.example.test",
  userId: "tester",
  debug: false,
};

describe("Neatlogs semantic attribute contract", () => {
  let runtimeRoot: string;
  let state: StateStore;

  beforeEach(() => {
    runtimeRoot = mkdtempSync(join(tmpdir(), "neatlogs-codex-semantics-"));
    state = new StateStore(runtimeRoot);
  });

  afterEach(() => rmSync(runtimeRoot, { recursive: true, force: true }));

  it("keeps emitted span fields within established or backend-forwarded Neatlogs fields", () => {
    const base = {
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/workspace",
      model: "gpt-5.6-codex",
      permission_mode: "default",
    } satisfies Partial<CodexHookPayload>;
    const payload = (
      hook_event_name: CodexHookPayload["hook_event_name"],
      patch: Partial<CodexHookPayload> = {},
    ): CodexHookPayload => ({ ...base, hook_event_name, ...patch } as CodexHookPayload);

    const results = [
      mapHookEvent(payload("UserPromptSubmit", { prompt: "Test the semantic contract" }), config, state, 1_000),
      mapHookEvent(
        payload("PreToolUse", {
          tool_name: "Bash",
          tool_use_id: "tool-1",
          tool_input: { command: "npm test" },
        }),
        config,
        state,
        1_100,
      ),
      mapHookEvent(
        payload("PostToolUse", {
          tool_name: "Bash",
          tool_use_id: "tool-1",
          tool_input: { command: "npm test" },
          tool_response: { exit_code: 1, output: "failed" },
        }),
        config,
        state,
        1_200,
      ),
      mapHookEvent(
        payload("PermissionRequest", { tool_name: "Bash", tool_input: { command: "publish" } }),
        config,
        state,
        1_300,
      ),
      mapHookEvent(payload("PreCompact", { trigger: "auto" }), config, state, 1_400),
      mapHookEvent(payload("PostCompact", { trigger: "auto" }), config, state, 1_500),
      mapHookEvent(
        payload("SubagentStart", { agent_id: "agent-1", agent_type: "reviewer" }),
        config,
        state,
        1_600,
      ),
      mapHookEvent(
        payload("SubagentStop", {
          agent_id: "agent-1",
          agent_type: "reviewer",
          last_assistant_message: "Done",
        }),
        config,
        state,
        1_700,
      ),
      mapHookEvent(
        payload("Stop", { last_assistant_message: "Finished" }),
        config,
        state,
        1_800,
      ),
    ];

    const emittedKeys = new Set(
      results.flatMap((result) =>
        result.spans.flatMap((span) => span.attributes.map(({ key }) => key)),
      ),
    );
    const unsupported = [...emittedKeys].filter(
      (key) =>
        !CLAUDE_PACKAGE_SEMANTIC_ATTRIBUTES.has(key) &&
        !key.startsWith("neatlogs.workflow.") &&
        !key.startsWith("neatlogs.session."),
    );

    expect(unsupported).toEqual([]);
    expect(emittedKeys).toContain("neatlogs.workflow_name");
    expect(emittedKeys).toContain("neatlogs.task_id");
    expect(emittedKeys).toContain("error.message");
    expect(emittedKeys).toContain("neatlogs.workflow.permission_mode");
    expect(emittedKeys).toContain("neatlogs.workflow.cwd");
    const simplifiedCustomKeys = [...emittedKeys]
      .filter(
        (key) =>
          key.startsWith("neatlogs.workflow.") || key.startsWith("neatlogs.session."),
      )
      .map((key) => key.slice("neatlogs.".length));
    expect(simplifiedCustomKeys).toContain("workflow.permission_mode");
    expect(simplifiedCustomKeys).toContain("workflow.cwd");
  });
});
