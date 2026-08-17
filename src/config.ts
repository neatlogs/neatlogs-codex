import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface NeatlogsConfig {
  apiKey: string;
  endpoint: string;
  userId: string;
  debug: boolean;
}

export interface ConfigFile {
  api_key?: string;
  endpoint?: string;
  user_id?: string;
  debug?: boolean;
}

export function getConfigPath(home = homedir()): string {
  return join(home, ".config", "neatlogs", "config.json");
}

function readConfigFile(path: string): ConfigFile {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : {};
  } catch {
    return {};
  }
}

function defaultUserId(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  path = getConfigPath(),
): NeatlogsConfig {
  const file = readConfigFile(path);
  return {
    apiKey: env.NEATLOGS_API_KEY ?? file.api_key ?? "",
    endpoint: env.NEATLOGS_ENDPOINT ?? file.endpoint ?? "https://ingest.neatlogs.com",
    userId: env.NEATLOGS_USER_ID ?? file.user_id ?? defaultUserId(),
    debug: env.NEATLOGS_DEBUG === "true" || (env.NEATLOGS_DEBUG === undefined && file.debug === true),
  };
}

export function updateConfig(patch: Partial<ConfigFile>, path = getConfigPath()): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const next = { ...readConfigFile(path), ...patch };
  const tempPath = join(directory, `.config-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
}
