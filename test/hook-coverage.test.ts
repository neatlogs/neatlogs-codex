import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_HOOK_EVENTS } from "../src/codex-events";

describe("Codex hook coverage", () => {
  it("bundles every supported event exactly once", () => {
    const hookFile = JSON.parse(
      readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
    ) as {
      hooks: Record<
        string,
        Array<{
          hooks: Array<{ type: string; command: string }>;
        }>
      >;
    };

    expect(Object.keys(hookFile.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    for (const event of CODEX_HOOK_EVENTS) {
      expect(hookFile.hooks[event]).toHaveLength(1);
      expect(hookFile.hooks[event][0].hooks).toHaveLength(1);
      expect(hookFile.hooks[event][0].hooks[0]).toMatchObject({
        type: "command",
        command: "node \"${PLUGIN_ROOT}/dist/cli.js\" hook",
      });
    }
  });
});
