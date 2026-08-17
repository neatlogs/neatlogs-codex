import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_HOOK_EVENTS, type CodexHookEventName } from "./codex-events";
import { getConfigPath, loadConfig, updateConfig } from "./config";

export type HookScope = "global" | "project";

interface CommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout: number;
  async?: boolean;
}

interface MatcherGroup {
  matcher?: string;
  hooks: CommandHook[];
}

interface HooksFile {
  description?: string;
  hooks?: Partial<Record<CodexHookEventName | string, MatcherGroup[]>>;
  [key: string]: unknown;
}

export interface SetupStatus {
  scope: HookScope;
  hooksPath: string;
  hooksFileExists: boolean;
  registeredEvents: CodexHookEventName[];
  apiKeyConfigured: boolean;
  inlineHooksDetected: boolean;
}

const OWNED_COMMAND = /(?:^|[\\/\s"'])neatlogs-codex(?:\.cmd)?(?:\s|$|["'])/i;

function targetDirectory(scope: HookScope, projectDirectory: string, home: string): string {
  return scope === "global" ? join(home, ".codex") : join(projectDirectory, ".codex");
}

export function targetPaths(
  scope: HookScope,
  projectDirectory = process.cwd(),
  home = homedir(),
): { hooksPath: string; configPath: string } {
  const directory = targetDirectory(scope, projectDirectory, home);
  return {
    hooksPath: join(directory, "hooks.json"),
    configPath: join(directory, "config.toml"),
  };
}

export function containsInlineHooks(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const eventNames = CODEX_HOOK_EVENTS.join("|");
    const inlineEvent = new RegExp(
      `^\\s*\\[\\[?hooks\\.(?:${eventNames})(?:\\.|\\]\\]?)`,
      "m",
    );
    return inlineEvent.test(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
}

function readHooksFile(path: string): HooksFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${path}`);
  }
  return parsed as HooksFile;
}

function writeHooksFile(path: string, file: HooksFile): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.hooks-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function eventHook(event: CodexHookEventName, command: string): MatcherGroup {
  const commandWindows = "neatlogs-codex.cmd hook";
  const synchronous = new Set<CodexHookEventName>([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "SubagentStart",
  ]);
  const timeout = event === "SessionEnd" ? 3 : synchronous.has(event) ? 5 : 30;
  return {
    hooks: [
      {
        type: "command",
        command,
        commandWindows,
        timeout,
        ...(event !== "SessionEnd" && !synchronous.has(event) ? { async: true } : {}),
      },
    ],
  };
}

function isOwnedGroup(group: MatcherGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some((hook) => OWNED_COMMAND.test(hook.command));
}

export function registerHooks(
  scope: HookScope,
  options: { projectDirectory?: string; home?: string; command?: string } = {},
): string {
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const home = options.home ?? homedir();
  const { hooksPath, configPath } = targetPaths(scope, projectDirectory, home);
  if (!existsSync(hooksPath) && containsInlineHooks(configPath)) {
    throw new Error(
      `Inline [hooks] configuration already exists in ${configPath}. ` +
        "Move it to hooks.json or install Neatlogs as a Codex plugin to avoid mixed hook representations.",
    );
  }

  const file = readHooksFile(hooksPath);
  const hooks = file.hooks && typeof file.hooks === "object" ? file.hooks : {};
  const command = options.command ?? "neatlogs-codex hook";

  for (const event of CODEX_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event]! : [];
    hooks[event] = [...existing.filter((group) => !isOwnedGroup(group)), eventHook(event, command)];
  }

  file.description ??= "Codex lifecycle hooks, including Neatlogs observability.";
  file.hooks = hooks;
  writeHooksFile(hooksPath, file);
  return hooksPath;
}

export function unregisterHooks(
  scope: HookScope,
  options: { projectDirectory?: string; home?: string } = {},
): { hooksPath: string; removed: number } {
  const { hooksPath } = targetPaths(
    scope,
    options.projectDirectory ?? process.cwd(),
    options.home ?? homedir(),
  );
  if (!existsSync(hooksPath)) return { hooksPath, removed: 0 };
  const file = readHooksFile(hooksPath);
  if (!file.hooks || typeof file.hooks !== "object") return { hooksPath, removed: 0 };

  let removed = 0;
  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!Array.isArray(groups)) continue;
    const retained = groups.filter((group) => !isOwnedGroup(group));
    removed += groups.length - retained.length;
    if (retained.length === 0) delete file.hooks[event];
    else file.hooks[event] = retained;
  }
  writeHooksFile(hooksPath, file);
  removeHooksFileIfEmpty(hooksPath);
  return { hooksPath, removed };
}

export function inspectSetup(
  scope: HookScope,
  options: { projectDirectory?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): SetupStatus {
  const home = options.home ?? homedir();
  const { hooksPath, configPath } = targetPaths(
    scope,
    options.projectDirectory ?? process.cwd(),
    home,
  );
  const hooksFileExists = existsSync(hooksPath);
  const file = hooksFileExists ? readHooksFile(hooksPath) : {};
  const registeredEvents = CODEX_HOOK_EVENTS.filter((event) =>
    (file.hooks?.[event] ?? []).some((group) => isOwnedGroup(group)),
  );
  return {
    scope,
    hooksPath,
    hooksFileExists,
    registeredEvents,
    apiKeyConfigured: Boolean(loadConfig(options.env ?? process.env, getConfigPath(home)).apiKey),
    inlineHooksDetected: containsInlineHooks(configPath),
  };
}

export function setupFromArgs(args: string[]): { scope: HookScope; hooksPath: string } {
  const scope: HookScope = args.includes("--global") ? "global" : "project";
  const keyIndex = args.indexOf("--api-key");
  const apiKey = keyIndex >= 0 ? args[keyIndex + 1] : undefined;
  if (keyIndex >= 0 && !apiKey) throw new Error("--api-key requires a value");
  if (apiKey) updateConfig({ api_key: apiKey });
  return { scope, hooksPath: registerHooks(scope) };
}

export function removeHooksFileIfEmpty(path: string): void {
  const file = readHooksFile(path);
  if (file.hooks && Object.keys(file.hooks).length > 0) return;
  const remaining = Object.keys(file).filter((key) => key !== "description" && key !== "hooks");
  if (remaining.length === 0) rmSync(path, { force: true });
}
