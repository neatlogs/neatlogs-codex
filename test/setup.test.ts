import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_HOOK_EVENTS } from "../src/codex-events";
import {
  inspectSetup,
  registerHooks,
  targetPaths,
  unregisterHooks,
} from "../src/setup";

describe("setup", () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "neatlogs-codex-setup-"));
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("registers every event idempotently while preserving unrelated hooks", () => {
    const { hooksPath } = targetPaths("project", project, home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "other-observer", timeout: 10 }],
            },
          ],
        },
      }),
    );

    registerHooks("project", { projectDirectory: project, home });
    registerHooks("project", { projectDirectory: project, home });

    const parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    expect(parsed.hooks.Stop.filter((group) => group.hooks[0].command === "other-observer")).toHaveLength(1);
    expect(
      parsed.hooks.Stop.filter((group) => group.hooks[0].command === "neatlogs-codex hook"),
    ).toHaveLength(1);

    const status = inspectSetup("project", {
      projectDirectory: project,
      home,
      env: {},
    });
    expect(status.registeredEvents).toEqual(CODEX_HOOK_EVENTS);
  });

  it("refuses to introduce hooks.json beside inline TOML hooks", () => {
    const { configPath } = targetPaths("project", project, home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(configPath, "[[hooks.Stop]]\n");

    expect(() => registerHooks("project", { projectDirectory: project, home })).toThrow(
      /Inline \[hooks\] configuration already exists/,
    );
  });

  it("does not mistake Codex hook trust state for inline hook definitions", () => {
    const { configPath } = targetPaths("project", project, home);
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(
      configPath,
      '[hooks.state]\n\n[hooks.state."/tmp/hooks.json:stop:0:0"]\ntrust = "allow"\n',
    );

    expect(() => registerHooks("project", { projectDirectory: project, home })).not.toThrow();
    expect(inspectSetup("project", { projectDirectory: project, home }).inlineHooksDetected).toBe(
      false,
    );
  });

  it("uninstalls only Neatlogs-owned hook groups", () => {
    const hooksPath = registerHooks("project", { projectDirectory: project, home });
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; type: "command"; timeout: number }> }>>;
    };
    parsed.hooks.Stop.unshift({
      hooks: [{ type: "command", command: "other-observer", timeout: 10 }],
    });
    writeFileSync(hooksPath, JSON.stringify(parsed));

    const result = unregisterHooks("project", { projectDirectory: project, home });
    expect(result.removed).toBe(CODEX_HOOK_EVENTS.length);
    const after = JSON.parse(readFileSync(hooksPath, "utf8")) as typeof parsed;
    expect(after.hooks.Stop[0].hooks[0].command).toBe("other-observer");
    expect(Object.keys(after.hooks)).toEqual(["Stop"]);
  });
});
