import { describe, expect, it } from "vitest";
import {
  CODEX_COMPATIBILITY_EVENTS,
  CODEX_COMPATIBILITY_EVENT_SUPPORT,
} from "../src/compatibility-events";
import { CODEX_HOOK_EVENTS } from "../src/codex-events";

describe("Codex compatibility event coverage", () => {
  it("tracks every Claude-only lifecycle name without registering it as a native hook", () => {
    expect(CODEX_COMPATIBILITY_EVENTS).toEqual([
      "PostToolUseFailure",
      "TaskCreated",
      "TaskCompleted",
      "PermissionDenied",
      "StopFailure",
      "InstructionsLoaded",
    ]);
    for (const event of CODEX_COMPATIBILITY_EVENTS) {
      expect(CODEX_HOOK_EVENTS).not.toContain(event);
      expect(CODEX_COMPATIBILITY_EVENT_SUPPORT[event]).toBeDefined();
    }
  });

  it("does not claim StopFailure or InstructionsLoaded can be observed", () => {
    expect(CODEX_COMPATIBILITY_EVENT_SUPPORT.StopFailure.support).toBe("unavailable");
    expect(CODEX_COMPATIBILITY_EVENT_SUPPORT.InstructionsLoaded.support).toBe("unavailable");
  });
});
