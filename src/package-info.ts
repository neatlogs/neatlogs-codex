import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "@neatlogs/codex";

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PACKAGE_VERSION = readPackageVersion();
