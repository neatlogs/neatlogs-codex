import { loadConfig, type NeatlogsConfig } from "./config";
import { isCodexHookPayload } from "./codex-events";
import { appendDebugLog } from "./diagnostics";
import { mapHookEvent } from "./event-mapper";
import { SpanSpool } from "./spool";
import { StateStore } from "./state-store";
import { TraceExporter, type SpanExportClient } from "./trace-shipper";
import { inspectCodexTranscriptSession } from "./transcript";

export interface HookHandlerDependencies {
  config?: NeatlogsConfig;
  state?: StateStore;
  spool?: SpanSpool;
  exporter?: SpanExportClient;
  now?: () => number;
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function handleHook(
  rawInput?: string,
  dependencies: HookHandlerDependencies = {},
): Promise<void> {
  const state = dependencies.state ?? new StateStore();
  const config = dependencies.config ?? loadConfig();

  try {
    const raw = rawInput ?? (await readStdin());
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!isCodexHookPayload(parsed)) {
      if (config.debug) appendDebugLog(state.root, "Ignored invalid or unsupported hook payload");
      return;
    }

    const transcriptSession = parsed.transcript_path
      ? inspectCodexTranscriptSession(parsed.transcript_path)
      : undefined;
    if (transcriptSession?.isSubagent) {
      if (config.debug) {
        appendDebugLog(
          state.root,
          `Ignored subagent-owned ${parsed.hook_event_name}; parent SubagentStop owns its spans`,
        );
      }
      return;
    }

    const now = dependencies.now?.() ?? Date.now();
    const result = mapHookEvent(parsed, config, state, now);
    const spool = dependencies.spool ?? new SpanSpool(state.root);

    if (config.apiKey && result.spans.length > 0) {
      spool.enqueue(result.spans, result.workflowName);
    }

    if (config.apiKey && (result.spans.length > 0 || parsed.hook_event_name === "SessionEnd")) {
      const exporter =
        dependencies.exporter ??
        new TraceExporter({
          apiKey: config.apiKey,
          endpoint: config.endpoint,
          timeoutMs: parsed.hook_event_name === "SessionEnd" ? 1_800 : 2_000,
        });
      await spool.drain(exporter, parsed.hook_event_name === "SessionEnd" ? 16 : 8);
    }

    if (result.cleanupSession) state.cleanupSession(parsed.session_id);
  } catch (error) {
    if (config.debug) {
      appendDebugLog(
        state.root,
        `Hook handler failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
