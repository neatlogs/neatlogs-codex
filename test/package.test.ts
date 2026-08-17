import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("keeps npm and Codex plugin versions aligned", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const pluginJson = JSON.parse(
      readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(pluginJson.version).toBe(packageJson.version);
  });
});
