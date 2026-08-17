import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

function safeSegment(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unknown";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

export function getRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEATLOGS_STATE_DIR) return env.NEATLOGS_STATE_DIR;
  if (env.PLUGIN_DATA) return join(env.PLUGIN_DATA, "runtime");
  if (env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "neatlogs-codex");
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "neatlogs-codex");
}

export class StateStore {
  constructor(public readonly root = getRuntimeRoot()) {}

  sessionDirectory(sessionId: string): string {
    return join(this.root, "sessions", safeSegment(sessionId));
  }

  private statePath(sessionId: string, key: string): string {
    return join(this.sessionDirectory(sessionId), `${safeSegment(key)}.json`);
  }

  write<T>(sessionId: string, key: string, value: T): void {
    const directory = this.sessionDirectory(sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = this.statePath(sessionId, key);
    const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, destination);
  }

  read<T>(sessionId: string, key: string): T | undefined {
    const path = this.statePath(sessionId, key);
    try {
      if (!existsSync(path)) return undefined;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  delete(sessionId: string, key: string): void {
    rmSync(this.statePath(sessionId, key), { force: true });
  }

  cleanupSession(sessionId: string): void {
    rmSync(this.sessionDirectory(sessionId), { recursive: true, force: true });
  }
}
