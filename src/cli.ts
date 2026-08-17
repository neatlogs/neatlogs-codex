#!/usr/bin/env node

import { handleHook } from "./hook-handler";
import { PACKAGE_VERSION } from "./package-info";
import {
  inspectSetup,
  setupFromArgs,
  unregisterHooks,
  type HookScope,
} from "./setup";

function write(message: string): void {
  process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
}

function scopeFromArgs(args: string[]): HookScope {
  return args.includes("--global") ? "global" : "project";
}

function help(): void {
  write(`neatlogs-codex v${PACKAGE_VERSION}\n`);
  write("Usage:");
  write("  neatlogs-codex setup [--global|--project] [--api-key KEY]");
  write("  neatlogs-codex uninstall [--global|--project]");
  write("  neatlogs-codex status [--global|--project]");
  write("  neatlogs-codex doctor [--global|--project]");
  write("  neatlogs-codex hook");
  write("  neatlogs-codex --version");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "hook") {
    await handleHook();
    return;
  }

  try {
    switch (command) {
      case "setup": {
        const result = setupFromArgs(args);
        write(`[neatlogs/codex] Registered hooks in ${result.hooksPath}`);
        write("[neatlogs/codex] Open /hooks in Codex to review and trust the hook definitions.");
        break;
      }
      case "uninstall": {
        const scope = scopeFromArgs(args);
        const result = unregisterHooks(scope);
        write(`[neatlogs/codex] Removed ${result.removed} hook entries from ${result.hooksPath}`);
        break;
      }
      case "status": {
        const status = inspectSetup(scopeFromArgs(args));
        write(JSON.stringify(status, null, 2));
        break;
      }
      case "doctor": {
        const status = inspectSetup(scopeFromArgs(args));
        const issues: string[] = [];
        if (!status.apiKeyConfigured) issues.push("Neatlogs API key is not configured");
        if (status.registeredEvents.length === 0) issues.push("Neatlogs hooks are not registered");
        if (status.inlineHooksDetected && status.hooksFileExists) {
          issues.push("This Codex config layer mixes inline hooks and hooks.json");
        }
        if (issues.length === 0) write("[neatlogs/codex] Configuration looks healthy.");
        else {
          issues.forEach((issue) => write(`[neatlogs/codex] ${issue}`));
          process.exitCode = 1;
        }
        break;
      }
      case "--version":
      case "-v":
        write(PACKAGE_VERSION);
        break;
      default:
        help();
    }
  } catch (error) {
    process.stderr.write(
      `[neatlogs/codex] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
