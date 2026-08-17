import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeatlogsConfig } from "../src/config";
import { handleHook } from "../src/hook-handler";
import { SpanSpool } from "../src/spool";
import { StateStore } from "../src/state-store";
import type { SpanExportClient } from "../src/trace-shipper";

const config: NeatlogsConfig = {
  apiKey: "test-key",
  endpoint: "https://ingest.example.test",
  userId: "tester",
  debug: false,
};

describe("handleHook", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not turn a subagent-owned hook stream into sibling turn traces", async () => {
    const root = mkdtempSync(join(tmpdir(), "neatlogs-codex-handler-"));
    directories.push(root);
    const transcriptPath = join(root, "agent-rollout.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-08-18T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "agent-thread",
          session_id: "parent-session",
          parent_thread_id: "parent-thread",
          thread_source: "subagent",
          source: { subagent: { thread_spawn: { agent_path: "/root/reviewer" } } },
        },
      })}\n`,
    );
    const state = new StateStore(root);
    const spool = new SpanSpool(root);
    const exporter: SpanExportClient = {
      exportSpans: vi.fn().mockResolvedValue("success"),
    };
    const dependencies = { config, state, spool, exporter, now: () => 1_000 };

    await handleHook(
      JSON.stringify({
        session_id: "parent-session",
        turn_id: "agent-turn",
        hook_event_name: "UserPromptSubmit",
        transcript_path: transcriptPath,
        prompt: "default",
      }),
      dependencies,
    );
    await handleHook(
      JSON.stringify({
        session_id: "parent-session",
        turn_id: "agent-turn",
        hook_event_name: "PostToolUse",
        transcript_path: transcriptPath,
        tool_name: "Bash",
        tool_use_id: "agent-tool",
        tool_response: { exit_code: 0, output: "ok" },
      }),
      dependencies,
    );
    await handleHook(
      JSON.stringify({
        session_id: "parent-session",
        turn_id: "agent-turn",
        hook_event_name: "Stop",
        transcript_path: transcriptPath,
        last_assistant_message: "Done",
      }),
      dependencies,
    );

    expect(exporter.exportSpans).not.toHaveBeenCalled();
    expect(spool.pendingFiles()).toEqual([]);
    expect(state.read("parent-session", "active-turn")).toBeUndefined();
  });
});
