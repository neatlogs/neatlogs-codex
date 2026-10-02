import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeHookLog } from "../src/compatibility-probe";

describe("captured Codex hook canary", () => {
  it("replays real-shaped lifecycle payloads through the packaged CLI and local OTLP sink", async () => {
    const directory = mkdtempSync(join(tmpdir(), "neatlogs-codex-canary-test-"));
    try {
      const path = join(directory, "hooks.jsonl");
      writeFileSync(path, [
        { session_id: "canary", hook_event_name: "SessionStart", source: "startup" },
        { session_id: "canary", turn_id: "turn", hook_event_name: "UserPromptSubmit", prompt: "OK" },
        { session_id: "canary", turn_id: "turn", hook_event_name: "Stop", last_assistant_message: "OK" },
      ].map((item) => JSON.stringify(item)).join("\n") + "\n");
      const result = await probeHookLog(path);
      expect(result).toMatchObject({ ok: true, errors: [] });
      expect(result.events).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
