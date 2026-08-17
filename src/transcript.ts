import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";

export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexLLMPhase {
  inputs: unknown[];
  text: string;
  reasoningSummary: string;
  toolCalls: string[];
  usage: CodexTokenUsage;
  hasReasoning: boolean;
  startMs?: number;
  endMs?: number;
}

export interface CodexTranscriptToolCall {
  callId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  startMs?: number;
  endMs?: number;
}

export interface CodexTranscriptSessionInfo {
  threadId?: string;
  parentThreadId?: string;
  threadSource?: string;
  isSubagent: boolean;
}

export interface CodexTranscriptSummary {
  turnId: string;
  model?: string;
  modelProvider?: string;
  effort?: string;
  approvalPolicy?: string;
  modelContextWindow?: number;
  collaborationMode?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  sessionSource?: string;
  cliVersion?: string;
  originator?: string;
  gitBranch?: string;
  gitCommit?: string;
  turnStatus?: "ok" | "error";
  turnError?: unknown;
  phases: CodexLLMPhase[];
  toolCalls: CodexTranscriptToolCall[];
  lastAssistantMessage?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
}

interface TranscriptEntry {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface MutablePhase {
  inputs: unknown[];
  text: string[];
  reasoningSummary: string[];
  toolCalls: string[];
  hasReasoning: boolean;
  startMs?: number;
  lastEventMs?: number;
}

const INITIAL_TAIL_BYTES = 1 * 1024 * 1024;
const MAX_TAIL_BYTES = 64 * 1024 * 1024;
const EMPTY_USAGE: CodexTokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasError(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function safeTurnError(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 8_192);
  const details = record(value);
  if (!details) return "Codex turn failed";
  const safe: Record<string, string | number | boolean> = {};
  for (const key of ["message", "type", "code", "param", "status"]) {
    const detail = details[key];
    if (typeof detail === "string") safe[key] = detail.slice(0, 8_192);
    else if (typeof detail === "number" || typeof detail === "boolean") safe[key] = detail;
  }
  return Object.keys(safe).length > 0 ? safe : "Codex turn failed";
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usageFrom(value: unknown): CodexTokenUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const result: CodexTokenUsage = {
    inputTokens: numberValue(usage.input_tokens) ?? 0,
    cachedInputTokens: numberValue(usage.cached_input_tokens) ?? 0,
    cacheWriteInputTokens: numberValue(usage.cache_write_input_tokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    reasoningOutputTokens: numberValue(usage.reasoning_output_tokens) ?? 0,
    totalTokens: numberValue(usage.total_tokens) ?? 0,
  };
  return Object.values(result).some((count) => count !== 0) ? result : undefined;
}

function newPhase(startMs?: number, inputs: unknown[] = []): MutablePhase {
  return {
    inputs,
    text: [],
    reasoningSummary: [],
    toolCalls: [],
    hasReasoning: false,
    startMs,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function summaryText(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.summary)) return [];
  return payload.summary.flatMap((part) => {
    const item = record(part);
    const text = stringValue(item?.text);
    return text ? [text] : [];
  });
}

function assistantText(payload: Record<string, unknown>): string[] {
  if (payload.role !== "assistant" || !Array.isArray(payload.content)) return [];
  return payload.content.flatMap((part) => {
    const item = record(part);
    if (item?.type !== "output_text" && item?.type !== "text") return [];
    const text = stringValue(item.text);
    return text ? [text] : [];
  });
}

function containsTurnStart(text: string, turnId?: string): boolean {
  return text.split("\n").some((line) => {
    if (turnId && !line.includes(turnId)) return false;
    return line.includes('"type":"task_started"') || line.includes('"type":"turn_context"');
  });
}

function readTailContainingTurn(path: string, turnId?: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return "";
    let bytes = Math.min(size, INITIAL_TAIL_BYTES);
    let text = "";
    let start = 0;
    while (true) {
      start = size - bytes;
      const buffer = Buffer.allocUnsafe(bytes);
      const read = readSync(descriptor, buffer, 0, bytes, start);
      text = buffer.subarray(0, read).toString("utf8");
      if (containsTurnStart(text, turnId) || start === 0 || bytes >= MAX_TAIL_BYTES) break;
      bytes = Math.min(size, MAX_TAIL_BYTES, bytes * 2);
    }
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}

function readSessionMetadataLine(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return undefined;
    const bytes = Math.min(size, INITIAL_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(descriptor, buffer, 0, bytes, 0);
    for (const line of buffer.subarray(0, read).toString("utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry.type === "session_meta") return line;
      } catch {
        // Ignore partially read or malformed records.
      }
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

export function inspectCodexTranscriptSession(
  transcriptPath: string,
): CodexTranscriptSessionInfo | undefined {
  const line = readSessionMetadataLine(transcriptPath);
  if (!line) return undefined;
  try {
    const entry = JSON.parse(line) as TranscriptEntry;
    const payload = record(entry.payload);
    if (entry.type !== "session_meta" || !payload) return undefined;
    const source = record(payload.source);
    return {
      threadId: stringValue(payload.id),
      parentThreadId: stringValue(payload.parent_thread_id),
      threadSource: stringValue(payload.thread_source),
      isSubagent:
        payload.thread_source === "subagent" ||
        Boolean(source?.subagent),
    };
  } catch {
    return undefined;
  }
}

function candidateTurnId(lines: string[], requestedTurnId?: string): string | undefined {
  if (requestedTurnId) return requestedTurnId;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as TranscriptEntry;
      const payload = record(entry.payload);
      if (entry.type === "turn_context" || payload?.type === "task_started") {
        const turnId = stringValue(payload?.turn_id);
        if (turnId) return turnId;
      }
    } catch {
      // Transcript records are append-only; tolerate a malformed or partially flushed line.
    }
  }
  return undefined;
}

export function parseCodexTranscript(
  transcriptPath: string,
  requestedTurnId?: string,
): CodexTranscriptSummary | undefined {
  const raw = readTailContainingTurn(transcriptPath, requestedTurnId);
  if (raw === undefined) return undefined;
  const sessionMetadata = readSessionMetadataLine(transcriptPath);
  const lines = [sessionMetadata, ...raw.split("\n")].filter(
    (line): line is string => Boolean(line?.trim()),
  );
  const turnId = candidateTurnId(lines, requestedTurnId);
  if (!turnId) return undefined;

  const result: CodexTranscriptSummary = { turnId, phases: [], toolCalls: [] };
  let currentTurnId: string | undefined;
  let inTargetTurn = false;
  let phase = newPhase();
  let nextPhaseInputs: unknown[] = [];
  const toolCalls = new Map<string, CodexTranscriptToolCall>();

  const finishPhase = (usage: CodexTokenUsage | undefined, endMs?: number): void => {
    const hasContent =
      phase.text.length > 0 ||
      phase.reasoningSummary.length > 0 ||
      phase.toolCalls.length > 0 ||
      phase.hasReasoning;
    if (!usage && !hasContent) return;
    result.phases.push({
      inputs: phase.inputs,
      text: phase.text.join("\n").trim(),
      reasoningSummary: phase.reasoningSummary.join("\n").trim(),
      toolCalls: unique(phase.toolCalls),
      usage: usage ?? { ...EMPTY_USAGE },
      hasReasoning: phase.hasReasoning || (usage?.reasoningOutputTokens ?? 0) > 0,
      startMs: phase.startMs,
      endMs: endMs ?? phase.lastEventMs,
    });
    phase = newPhase(endMs ?? phase.lastEventMs, nextPhaseInputs);
    nextPhaseInputs = [];
  };

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const payload = record(entry.payload);
    if (!payload) continue;
    const eventMs = timestampMs(entry.timestamp);

    if (entry.type === "session_meta") {
      result.modelProvider ??= stringValue(payload.model_provider);
      result.sessionSource ??= stringValue(payload.source);
      result.cliVersion ??= stringValue(payload.cli_version);
      result.originator ??= stringValue(payload.originator);
      const git = record(payload.git);
      result.gitBranch ??= stringValue(git?.branch);
      result.gitCommit ??= stringValue(git?.commit_hash);
      continue;
    }

    if (payload.type === "task_started") {
      currentTurnId = stringValue(payload.turn_id);
      inTargetTurn = currentTurnId === turnId;
      phase = newPhase(timestampMs(payload.started_at) ?? eventMs);
      nextPhaseInputs = [];
      if (inTargetTurn) {
        result.modelContextWindow =
          numberValue(payload.model_context_window) ?? result.modelContextWindow;
        result.collaborationMode =
          stringValue(payload.collaboration_mode_kind) ?? result.collaborationMode;
      }
      continue;
    }

    if (entry.type === "turn_context") {
      currentTurnId = stringValue(payload.turn_id) ?? currentTurnId;
      inTargetTurn = currentTurnId === turnId;
      if (inTargetTurn) {
        result.model = stringValue(payload.model) ?? result.model;
        result.effort = stringValue(payload.effort) ?? result.effort;
        result.approvalPolicy = stringValue(payload.approval_policy) ?? result.approvalPolicy;
        const collaborationMode = record(payload.collaboration_mode);
        result.collaborationMode =
          stringValue(collaborationMode?.mode) ?? result.collaborationMode;
        const sandboxPolicy = record(payload.sandbox_policy);
        const fileSystemSandboxPolicy = record(payload.file_system_sandbox_policy);
        result.sandboxMode =
          stringValue(sandboxPolicy?.type) ??
          stringValue(fileSystemSandboxPolicy?.type) ??
          result.sandboxMode;
        result.networkAccess =
          booleanValue(sandboxPolicy?.network_access) ?? result.networkAccess;
        phase.startMs ??= eventMs;
      }
      continue;
    }

    if (!inTargetTurn) continue;
    phase.lastEventMs = eventMs ?? phase.lastEventMs;

    if (entry.type === "response_item") {
      if (payload.type === "message") phase.text.push(...assistantText(payload));
      if (payload.type === "reasoning") {
        phase.hasReasoning = true;
        phase.reasoningSummary.push(...summaryText(payload));
      }
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = stringValue(payload.name);
        if (name) phase.toolCalls.push(name);
        const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
        if (name && callId) {
          const toolCall: CodexTranscriptToolCall = {
            callId,
            name,
            input: payload.arguments ?? payload.input,
            startMs: eventMs,
          };
          toolCalls.set(callId, toolCall);
          result.toolCalls.push(toolCall);
        }
      }
      if (
        payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output"
      ) {
        const callId = stringValue(payload.call_id);
        const toolCall = callId ? toolCalls.get(callId) : undefined;
        if (toolCall) {
          toolCall.output = payload.output;
          toolCall.endMs = eventMs;
        }
        if (payload.output !== undefined) nextPhaseInputs.push(payload.output);
      }
      continue;
    }

    if (entry.type !== "event_msg") continue;

    if (payload.type === "token_count") {
      const info = record(payload.info);
      result.modelContextWindow =
        numberValue(info?.model_context_window) ?? result.modelContextWindow;
      finishPhase(usageFrom(info?.last_token_usage), eventMs);
      continue;
    }

    if (payload.type === "task_complete" && payload.turn_id === turnId) {
      finishPhase(undefined, eventMs);
      result.lastAssistantMessage = stringValue(payload.last_agent_message);
      result.durationMs = numberValue(payload.duration_ms);
      result.timeToFirstTokenMs = numberValue(payload.time_to_first_token_ms);
      result.turnStatus = hasError(payload.error) ? "error" : "ok";
      if (result.turnStatus === "error") result.turnError = safeTurnError(payload.error);
      break;
    }
  }

  finishPhase(undefined);
  return result;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function parseCodexTranscriptWithRetry(
  transcriptPath: string,
  turnId?: string,
): CodexTranscriptSummary | undefined {
  const delays = [0, 50, 100, 200];
  let summary: CodexTranscriptSummary | undefined;
  for (const delay of delays) {
    if (delay) sleepSync(delay);
    summary = parseCodexTranscript(transcriptPath, turnId);
    if (summary && summary.phases.some((phase) => phase.usage.totalTokens > 0)) return summary;
  }
  return summary;
}
