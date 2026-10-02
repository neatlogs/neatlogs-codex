import { readFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isCodexHookPayload } from "./codex-events";
import { hasWorkflowSpanInTraceRequest } from "./trace-shipper";

/** Replays a disposable Codex canary's real hook payloads through this package. */
export async function probeHookLog(
  path: string,
  cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
): Promise<{ ok: boolean; events: string[]; errors: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "neatlogs-codex-probe-"));
  const events: string[] = [];
  const errors: string[] = [];
  const replayInputs: string[] = [];
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const line of lines.slice(0, 40)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isCodexHookPayload(parsed)) {
          errors.push("Codex emitted an unsupported hook payload");
          continue;
        }
        if (parsed.hook_event_name === "UserPromptSubmit" && typeof parsed.prompt !== "string") {
          errors.push("UserPromptSubmit omitted its documented string prompt");
        }
        events.push(parsed.hook_event_name);
        // The transcript format is explicitly unstable; this probe checks the
        // documented hook payload contract without reading user transcripts.
        const payload = { ...parsed, transcript_path: undefined, agent_transcript_path: undefined };
        replayInputs.push(JSON.stringify(payload));
      } catch {
        errors.push("A captured hook payload could not be parsed");
      }
    }
    for (const required of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      if (!events.includes(required)) errors.push(`${required} hook did not fire`);
    }
    const stateRoot = join(root, "cli");
    const childHome = join(root, "cli-home");
    mkdirSync(stateRoot, { mode: 0o777 });
    mkdirSync(childHome, { mode: 0o777 });
    if (process.env.COMPAT_UNPRIVILEGED === "true") {
      chmodSync(root, 0o755);
      chmodSync(stateRoot, 0o777);
      chmodSync(childHome, 0o777);
    }
    const exported: Uint8Array[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        exported.push(Buffer.concat(chunks));
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local OTLP sink did not start");
      for (const input of replayInputs) {
        const exit = await new Promise<number>((resolve) => {
          const variables = {
            PATH: process.env.PATH ?? "",
            HOME: childHome,
            NEATLOGS_STATE_DIR: stateRoot,
            NEATLOGS_API_KEY: "local-canary-key",
            NEATLOGS_ENDPOINT: `http://127.0.0.1:${address.port}`,
            NEATLOGS_USER_ID: "compatibility-canary",
          };
          const unprivileged = process.env.COMPAT_UNPRIVILEGED === "true";
          const child = spawn(unprivileged ? "sudo" : process.execPath,
            unprivileged
              ? ["-n", "-u", "nobody", "--", "env", "-i", ...Object.entries(variables).map(([key, value]) => `${key}=${value}`), process.execPath, cliPath, "hook"]
              : [cliPath, "hook"], {
            env: unprivileged ? { PATH: process.env.PATH } : variables,
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.on("error", () => resolve(-1));
          child.on("close", (code) => resolve(code ?? -1));
          child.stdin.end(input);
        });
        if (exit !== 0) errors.push("Packaged Neatlogs hook handler failed");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (!exported.some(hasWorkflowSpanInTraceRequest)) {
      errors.push("Packaged hook handler did not export a workflow span to the local OTLP sink");
    }
    return { ok: errors.length === 0, events: [...new Set(events)], errors };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("compatibility-probe.js") || process.argv[1]?.endsWith("trusted-probe.mjs")) {
  probeHookLog(process.argv[2], process.argv[3]).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Compatibility probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
