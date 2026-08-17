import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function appendDebugLog(runtimeRoot: string, message: string): void {
  try {
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(runtimeRoot, "debug.log"),
      `[${new Date().toISOString()}] ${message}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Observability diagnostics must never affect Codex.
  }
}
