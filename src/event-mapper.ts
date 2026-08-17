import type { NeatlogsConfig } from "./config";
import type { CodexHookPayload } from "./codex-events";
import {
  deriveCodexCompatibilityEvents,
  type DerivedCodexCompatibilityEvent,
} from "./compatibility-events";
import type { StateStore } from "./state-store";
import {
  parseCodexTranscript,
  parseCodexTranscriptWithRetry,
  type CodexTranscriptSummary,
} from "./transcript";
import {
  SpanStatusCode,
  attrBool,
  attrDouble,
  attrInt,
  attrString,
  bytesToHex,
  deterministicId,
  msToNanoString,
  type OtlpKeyValue,
  type OtlpSpan,
} from "./trace-shipper";

interface SessionState {
  source?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
}

interface ActiveTurnState {
  turnId: string;
}

export interface TurnState {
  turnId: string;
  prompt?: string;
  startMs: number;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  completed?: boolean;
}

interface TimingState {
  startMs: number;
}

export interface MapResult {
  spans: OtlpSpan[];
  compatibilityEvents?: DerivedCodexCompatibilityEvent[];
  workflowName?: string;
  cleanupSession?: boolean;
}

const MAX_STRING_LENGTH = 32_768;
const SENSITIVE_KEY = /(^|_)(api[-_]?key|authorization|cookie|password|secret|token)($|_)/i;

function truncate(value: string, limit = MAX_STRING_LENGTH): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function sanitizeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return truncate(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[max depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(child, depth + 1, seen);
  }
  return result;
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return truncate(JSON.stringify(sanitizeValue(value)));
  } catch {
    return truncate(String(value));
  }
}

function errorText(value: unknown): string | undefined {
  return typeof value === "string" ? truncate(value) : safeStringify(value);
}

function turnStateKey(turnId: string): string {
  return `turn:${turnId}`;
}

function toolStateKey(turnId: string, toolUseId: string): string {
  return `tool:${turnId}:${toolUseId}`;
}

function agentStateKey(turnId: string, agentId: string): string {
  return `agent:${turnId}:${agentId}`;
}

function activeTurn(state: StateStore, sessionId: string): ActiveTurnState | undefined {
  return state.read<ActiveTurnState>(sessionId, "active-turn");
}

function resolveTurnId(payload: CodexHookPayload, state: StateStore): string {
  return payload.turn_id ?? activeTurn(state, payload.session_id)?.turnId ?? "session";
}

function readSessionState(payload: CodexHookPayload, state: StateStore): SessionState {
  return state.read<SessionState>(payload.session_id, "session") ?? {};
}

function ensureTurnState(
  payload: CodexHookPayload,
  state: StateStore,
  now: number,
): TurnState {
  const turnId = resolveTurnId(payload, state);
  const key = turnStateKey(turnId);
  const existing = state.read<TurnState>(payload.session_id, key);
  if (existing) return existing;
  const session = readSessionState(payload, state);
  const created: TurnState = {
    turnId,
    prompt: payload.prompt,
    startMs: now,
    model: payload.model ?? session.model,
    cwd: payload.cwd ?? session.cwd,
    permissionMode: payload.permission_mode ?? session.permissionMode,
  };
  state.write(payload.session_id, key, created);
  state.write<ActiveTurnState>(payload.session_id, "active-turn", { turnId });
  return created;
}

function ensureActiveParentTurnState(
  payload: CodexHookPayload,
  state: StateStore,
  now: number,
): TurnState {
  const active = activeTurn(state, payload.session_id);
  if (active) {
    const parent = state.read<TurnState>(
      payload.session_id,
      turnStateKey(active.turnId),
    );
    if (parent) return parent;
  }
  return ensureTurnState(payload, state, now);
}

function traceId(payload: CodexHookPayload, turnId: string): Uint8Array {
  return deterministicId(`codex:${payload.session_id}:${turnId}`, 16);
}

function rootSpanId(payload: CodexHookPayload, turnId: string): Uint8Array {
  return deterministicId(`codex:${payload.session_id}:${turnId}:root`, 8);
}

function workflowName(turn: TurnState): string {
  const normalized = turn.prompt?.replace(/\s+/g, " ").trim();
  return normalized ? truncate(normalized, 80) : "codex";
}

function attributes(values: Array<OtlpKeyValue | undefined>): OtlpKeyValue[] {
  return values.filter((value): value is OtlpKeyValue => value !== undefined);
}

function createChildSpan(
  payload: CodexHookPayload,
  turn: TurnState,
  identity: string,
  name: string,
  startMs: number,
  endMs: number,
  spanAttributes: Array<OtlpKeyValue | undefined>,
  status?: { code: number; message?: string },
  parentSpanId?: Uint8Array,
): OtlpSpan {
  return {
    traceId: traceId(payload, turn.turnId),
    spanId: deterministicId(`codex:${payload.session_id}:${turn.turnId}:${identity}`, 8),
    parentSpanId: parentSpanId ?? rootSpanId(payload, turn.turnId),
    name,
    kind: 1,
    startTimeUnixNano: msToNanoString(startMs),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: attributes([
      attrString("neatlogs.session.id", payload.session_id),
      ...spanAttributes,
    ]),
    status,
  };
}

function workflowMetadataAttributes(
  payload: CodexHookPayload,
  turn: TurnState,
  transcript: CodexTranscriptSummary | undefined,
  session: SessionState,
  turnStatus?: "ok" | "error" | "incomplete",
): Array<OtlpKeyValue | undefined> {
  return [
    attrString("neatlogs.workflow.cwd", turn.cwd ?? payload.cwd),
    attrString(
      "neatlogs.workflow.permission_mode",
      turn.permissionMode ?? payload.permission_mode,
    ),
    attrString("neatlogs.workflow.approval_policy", transcript?.approvalPolicy),
    attrString("neatlogs.workflow.effort_level", transcript?.effort),
    attrInt("neatlogs.workflow.model_context_window", transcript?.modelContextWindow),
    attrString("neatlogs.workflow.collaboration_mode", transcript?.collaborationMode),
    attrString("neatlogs.workflow.sandbox_mode", transcript?.sandboxMode),
    attrBool("neatlogs.workflow.network_access", transcript?.networkAccess),
    attrString("neatlogs.workflow.turn_status", turnStatus ?? transcript?.turnStatus),
    attrString("neatlogs.workflow.turn_error", errorText(transcript?.turnError)),
    attrInt("neatlogs.workflow.time_to_first_token_ms", transcript?.timeToFirstTokenMs),
    attrBool("neatlogs.workflow.stop_hook_active", payload.stop_hook_active),
    attrString("neatlogs.session.start_source", session.source),
    attrString("neatlogs.session.client", transcript?.sessionSource),
    attrString("neatlogs.session.cli_version", transcript?.cliVersion),
    attrString("neatlogs.session.originator", transcript?.originator),
    attrString("neatlogs.session.git.branch", transcript?.gitBranch),
    attrString("neatlogs.session.git.commit", transcript?.gitCommit),
    attrString("neatlogs.session.end_reason", payload.reason),
  ];
}

function llmRuntimeAttributes(
  transcript: CodexTranscriptSummary,
  phaseIndex: number,
): Array<OtlpKeyValue | undefined> {
  return [
    // These workflow-prefixed custom fields are intentionally placed only on
    // LLM spans so the existing Neatlogs finalizer preserves them in
    // spans_simplified.span_metadata.
    attrString("neatlogs.workflow.effort_level", transcript.effort),
    attrInt("neatlogs.workflow.model_context_window", transcript.modelContextWindow),
    attrInt(
      "neatlogs.workflow.time_to_first_token_ms",
      phaseIndex === 0 ? transcript.timeToFirstTokenMs : undefined,
    ),
  ];
}

function toolResponseError(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const record = response as Record<string, unknown>;
  if (record.isError === true || record.success === false) {
    return typeof record.error === "string" ? record.error : "Tool execution failed";
  }
  if (typeof record.exit_code === "number" && record.exit_code !== 0) {
    return `Tool exited with code ${record.exit_code}`;
  }
  if (typeof record.status === "string" && /^(error|failed|failure)$/i.test(record.status)) {
    return typeof record.error === "string" ? record.error : `Tool status: ${record.status}`;
  }
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  return undefined;
}

function rootAndCompletionSpans(
  payload: CodexHookPayload,
  config: NeatlogsConfig,
  turn: TurnState,
  endMs: number,
  transcript?: CodexTranscriptSummary,
  session: SessionState = {},
): OtlpSpan[] {
  const rootId = rootSpanId(payload, turn.turnId);
  const turnStatus = transcript?.turnStatus ??
    (payload.hook_event_name === "SessionEnd" ? "incomplete" : "ok");
  const turnError = errorText(transcript?.turnError);
  const root: OtlpSpan = {
    traceId: traceId(payload, turn.turnId),
    spanId: rootId,
    name: workflowName(turn),
    kind: 1,
    startTimeUnixNano: msToNanoString(Math.min(turn.startMs, endMs)),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: attributes([
      attrString("neatlogs.session.id", payload.session_id),
      attrString(
        "neatlogs.llm.model_name",
        transcript?.model ?? payload.model ?? turn.model,
      ),
      attrString("neatlogs.span.kind", "WORKFLOW"),
      attrString("neatlogs.workflow_name", workflowName(turn)),
      attrString("neatlogs.llm.provider", transcript?.modelProvider ?? "openai"),
      attrString("neatlogs.llm.request_type", "generateText"),
      attrString("neatlogs.llm.effort_level", transcript?.effort),
      ...workflowMetadataAttributes(payload, turn, transcript, session, turnStatus),
      attrString("neatlogs.user_id", config.userId),
      attrString("neatlogs.input.value", turn.prompt),
      attrString(
        "neatlogs.output.value",
        payload.last_assistant_message ?? transcript?.lastAssistantMessage,
      ),
      attrInt(
        "neatlogs.llm.metrics.duration_ms",
        transcript?.durationMs ?? Math.max(0, endMs - turn.startMs),
      ),
      attrString("error.message", turnError),
    ]),
    status: turnStatus === "error"
      ? { code: SpanStatusCode.ERROR, message: turnError }
      : { code: SpanStatusCode.OK },
  };

  const marker: OtlpSpan = {
    traceId: traceId(payload, turn.turnId),
    spanId: deterministicId(`codex:${payload.session_id}:${turn.turnId}:complete`, 8),
    parentSpanId: rootId,
    name: "neatlogs.trace.complete",
    kind: 1,
    startTimeUnixNano: msToNanoString(endMs),
    endTimeUnixNano: msToNanoString(endMs),
    attributes: [],
  };
  return [root, marker];
}

function displayToolName(name: string): string {
  return name === "exec" ? "Bash" : name;
}

function llmPhaseInput(
  phase: CodexTranscriptSummary["phases"][number],
  index: number,
  turn: TurnState,
  firstInput?: string,
): string {
  if (index === 0 && (firstInput ?? turn.prompt)) return (firstInput ?? turn.prompt)!;
  if (phase.inputs.length === 1) {
    const input = phase.inputs[0];
    return typeof input === "string" ? truncate(input) : safeStringify(input) ?? "Continuation";
  }
  if (phase.inputs.length > 1) return safeStringify(phase.inputs) ?? "Continuation";
  return "Continuation of the current turn";
}

function llmPhaseOutput(phase: CodexTranscriptSummary["phases"][number]): string {
  if (phase.text) return phase.text;
  const toolCalls = phase.toolCalls.map(displayToolName);
  if (toolCalls.length > 0) return `Tool calls requested: ${toolCalls.join(", ")}`;
  if (phase.reasoningSummary) return phase.reasoningSummary;
  if (phase.hasReasoning) {
    return "Reasoning completed; raw encrypted reasoning is not exported.";
  }
  return "Model request completed without displayable text.";
}

function transcriptLLMSpans(
  payload: CodexHookPayload,
  turn: TurnState,
  transcript: CodexTranscriptSummary,
  options: { identityPrefix?: string; parentSpanId?: Uint8Array; firstInput?: string } = {},
): OtlpSpan[] {
  return transcript.phases.map((phase, index) => {
    const model = transcript.model ?? payload.model ?? turn.model ?? "codex";
    const startMs = phase.startMs ?? turn.startMs;
    const endMs = phase.endMs ?? startMs;
    const toolCalls = phase.toolCalls.map(displayToolName).join(", ");
    return createChildSpan(
      payload,
      turn,
      `${options.identityPrefix ?? "llm"}:${index}:${phase.endMs ?? index}`,
      model,
      startMs,
      endMs,
      [
        attrString("neatlogs.span.kind", "LLM"),
        attrString("neatlogs.llm.request_type", "generateText"),
        attrString("neatlogs.llm.model_name", model),
        attrString("neatlogs.llm.provider", transcript.modelProvider ?? "openai"),
        attrString("neatlogs.llm.effort_level", transcript.effort),
        ...llmRuntimeAttributes(transcript, index),
        attrInt("neatlogs.llm.token_count.total", phase.usage.totalTokens),
        attrInt("neatlogs.llm.token_count.prompt", phase.usage.inputTokens),
        attrInt("neatlogs.llm.token_count.completion", phase.usage.outputTokens),
        attrInt("neatlogs.llm.token_count.reasoning", phase.usage.reasoningOutputTokens),
        ...(phase.usage.cachedInputTokens > 0
          ? [
              attrInt("neatlogs.llm.token_count.cache_read", phase.usage.cachedInputTokens),
              attrInt("neatlogs.llm.token_count.cached", phase.usage.cachedInputTokens),
            ]
          : []),
        ...(phase.usage.cacheWriteInputTokens > 0
          ? [attrInt("neatlogs.llm.token_count.cache_write", phase.usage.cacheWriteInputTokens)]
          : []),
        attrString(
          "neatlogs.input.value",
          llmPhaseInput(phase, index, turn, options.firstInput),
        ),
        attrString("neatlogs.output.value", llmPhaseOutput(phase)),
        attrString("neatlogs.llm.thinking", phase.reasoningSummary || undefined),
        attrString("neatlogs.llm.has_thinking", phase.hasReasoning ? "true" : undefined),
        attrString("neatlogs.llm.tool_calls", toolCalls || undefined),
        attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, endMs - startMs)),
        ...(index === 0 && transcript.timeToFirstTokenMs !== undefined
          ? [
              attrDouble(
                "neatlogs.llm.metrics.time_to_first_token",
                transcript.timeToFirstTokenMs,
              ),
            ]
          : []),
      ],
      transcript.turnStatus === "error"
        ? { code: SpanStatusCode.ERROR, message: errorText(transcript.turnError) }
        : { code: SpanStatusCode.OK },
      options.parentSpanId,
    );
  });
}

function transcriptToolSpans(
  payload: CodexHookPayload,
  turn: TurnState,
  transcript: CodexTranscriptSummary,
  parentSpanId: Uint8Array,
): OtlpSpan[] {
  return transcript.toolCalls.map((toolCall, index) => {
    const startMs = toolCall.startMs ?? turn.startMs;
    const endMs = toolCall.endMs ?? startMs;
    const error = toolResponseError(toolCall.output);
    const name = toolCall.name === "exec" ? "Bash" : toolCall.name;
    return createChildSpan(
      payload,
      turn,
      `agent-tool:${toolCall.callId || index}`,
      name,
      startMs,
      endMs,
      [
        attrString("neatlogs.span.kind", "TOOL"),
        attrString("neatlogs.tool.name", name),
        attrString("neatlogs.tool_call.id", toolCall.callId),
        attrString("neatlogs.tool.input", safeStringify(toolCall.input)),
        attrString("neatlogs.tool.output", safeStringify(toolCall.output)),
        attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, endMs - startMs)),
        attrString("error.message", error),
      ],
      error
        ? { code: SpanStatusCode.ERROR, message: error }
        : { code: SpanStatusCode.OK },
      parentSpanId,
    );
  });
}

function sessionEndSpan(
  payload: CodexHookPayload,
  turn: TurnState,
  now: number,
): OtlpSpan {
  return createChildSpan(
    payload,
    turn,
    `session-end:${payload.reason ?? "unknown"}`,
    "session_end",
    now,
    now,
    [
      attrString("neatlogs.span.kind", "LOG"),
      attrString("neatlogs.session.end_reason", payload.reason),
      attrString("neatlogs.output.value", payload.reason ?? "Session ended"),
    ],
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Codex hook event: ${String(value)}`);
}

export function mapHookEvent(
  payload: CodexHookPayload,
  config: NeatlogsConfig,
  state: StateStore,
  now = Date.now(),
): MapResult {
  const eventName = payload.hook_event_name;
  switch (eventName) {
    case "SessionStart": {
      const existing = readSessionState(payload, state);
      state.write<SessionState>(payload.session_id, "session", {
        source: payload.source ?? existing.source,
        model: payload.model ?? existing.model,
        cwd: payload.cwd ?? existing.cwd,
        permissionMode: payload.permission_mode ?? existing.permissionMode,
      });
      return { spans: [] };
    }

    case "UserPromptSubmit": {
      const turnId = resolveTurnId(payload, state);
      const session = readSessionState(payload, state);
      const turn: TurnState = {
        turnId,
        prompt: payload.prompt,
        startMs: now,
        model: payload.model ?? session.model,
        cwd: payload.cwd ?? session.cwd,
        permissionMode: payload.permission_mode ?? session.permissionMode,
      };
      state.write(payload.session_id, turnStateKey(turnId), turn);
      state.write<ActiveTurnState>(payload.session_id, "active-turn", { turnId });
      return { spans: [], workflowName: workflowName(turn) };
    }

    case "PreToolUse": {
      const turn = ensureTurnState(payload, state, now);
      if (payload.tool_use_id) {
        state.write<TimingState>(
          payload.session_id,
          toolStateKey(turn.turnId, payload.tool_use_id),
          { startMs: now },
        );
      }
      return { spans: [], workflowName: workflowName(turn) };
    }

    case "PostToolUse": {
      const turn = ensureTurnState(payload, state, now);
      const timing = payload.tool_use_id
        ? state.read<TimingState>(payload.session_id, toolStateKey(turn.turnId, payload.tool_use_id))
        : undefined;
      if (payload.tool_use_id) {
        state.delete(payload.session_id, toolStateKey(turn.turnId, payload.tool_use_id));
      }
      const startMs = timing?.startMs ?? now;
      const error = toolResponseError(payload.tool_response);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload, { toolError: error });
      const identity = `tool:${payload.tool_use_id ?? `${payload.tool_name ?? "unknown"}:${now}`}`;
      const span = createChildSpan(
        payload,
        turn,
        identity,
        payload.tool_name ?? "tool",
        startMs,
        now,
        [
          attrString("neatlogs.span.kind", "TOOL"),
          attrString("neatlogs.tool.name", payload.tool_name),
          attrString("neatlogs.tool_call.id", payload.tool_use_id),
          attrString("neatlogs.tool.input", safeStringify(payload.tool_input)),
          attrString("neatlogs.tool.output", safeStringify(payload.tool_response)),
          attrInt("neatlogs.llm.metrics.duration_ms", Math.max(0, now - startMs)),
          attrString("error.message", error),
        ],
        error
          ? { code: SpanStatusCode.ERROR, message: error }
          : { code: SpanStatusCode.OK },
      );
      return { spans: [span], compatibilityEvents, workflowName: workflowName(turn) };
    }

    case "PermissionRequest": {
      const turn = ensureTurnState(payload, state, now);
      const span = createChildSpan(
        payload,
        turn,
        `permission:${payload.tool_name ?? "tool"}:${now}`,
        `${payload.tool_name ?? "tool"} permission request`,
        now,
        now,
        [
          attrString("neatlogs.span.kind", "TOOL"),
          attrString("neatlogs.tool.name", payload.tool_name),
          attrString("neatlogs.tool.input", safeStringify(payload.tool_input)),
          attrString("neatlogs.tool.output", "Permission requested"),
        ],
      );
      return { spans: [span], workflowName: workflowName(turn) };
    }

    case "SubagentStart": {
      const turn = ensureActiveParentTurnState(payload, state, now);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload);
      if (payload.agent_id) {
        state.write<TimingState>(
          payload.session_id,
          agentStateKey(turn.turnId, payload.agent_id),
          { startMs: now },
        );
      }
      const taskCreated = createChildSpan(
        payload,
        turn,
        `task-created:${payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`}`,
        "TaskCreated",
        now,
        now,
        [
          attrString("neatlogs.span.kind", "WORKFLOW"),
          attrString("neatlogs.workflow_name", payload.agent_type ?? "subagent"),
          attrString("neatlogs.task_id", payload.agent_id),
          attrString("neatlogs.input.value", payload.agent_type ?? "subagent"),
          attrString("neatlogs.output.value", "Task created"),
          attrInt("neatlogs.llm.metrics.duration_ms", 0),
        ],
      );
      return {
        spans: [taskCreated],
        compatibilityEvents,
        workflowName: workflowName(turn),
      };
    }

    case "SubagentStop": {
      // Codex identifies this callback with the subagent's turn_id. Keep the
      // reconstructed AGENT/LLM/TOOL subtree on the active parent turn.
      const turn = ensureActiveParentTurnState(payload, state, now);
      const compatibilityEvents = deriveCodexCompatibilityEvents(payload);
      const timing = payload.agent_id
        ? state.read<TimingState>(payload.session_id, agentStateKey(turn.turnId, payload.agent_id))
        : undefined;
      if (payload.agent_id) {
        state.delete(payload.session_id, agentStateKey(turn.turnId, payload.agent_id));
      }
      const startMs = timing?.startMs ?? now;
      const transcript = payload.agent_transcript_path
        ? parseCodexTranscriptWithRetry(payload.agent_transcript_path)
        : undefined;
      const agentError = errorText(transcript?.turnError);
      const agentSpanId = deterministicId(
        `codex:${payload.session_id}:${turn.turnId}:agent:${
          payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`
        }`,
        8,
      );
      const span = createChildSpan(
        payload,
        turn,
        `agent:${payload.agent_id ?? `${payload.agent_type ?? "subagent"}:${now}`}`,
        payload.agent_type ?? "subagent",
        startMs,
        now,
        [
          attrString("neatlogs.span.kind", "AGENT"),
          attrString("neatlogs.agent.name", payload.agent_type),
          attrString("neatlogs.agent_id", payload.agent_id),
          attrString("neatlogs.llm.model_name", transcript?.model),
          attrString("neatlogs.llm.provider", transcript?.modelProvider),
          attrString("neatlogs.llm.effort_level", transcript?.effort),
          attrString("neatlogs.workflow.effort_level", transcript?.effort),
          attrInt("neatlogs.workflow.model_context_window", transcript?.modelContextWindow),
          attrBool("neatlogs.workflow.stop_hook_active", payload.stop_hook_active),
          attrString(
            "neatlogs.output.value",
            payload.last_assistant_message ?? transcript?.lastAssistantMessage,
          ),
          attrString("neatlogs.task_id", payload.agent_id),
          attrInt(
            "neatlogs.llm.metrics.duration_ms",
            transcript?.durationMs ?? Math.max(0, now - startMs),
          ),
          attrString("error.message", agentError),
        ],
        transcript?.turnStatus === "error"
          ? { code: SpanStatusCode.ERROR, message: agentError }
          : { code: SpanStatusCode.OK },
      );
      const llmSpans = transcript
        ? transcriptLLMSpans(payload, turn, transcript, {
            identityPrefix: `agent:${payload.agent_id ?? "subagent"}:llm`,
            parentSpanId: agentSpanId,
            firstInput: payload.agent_type ?? "Subagent task",
          })
        : [];
      const toolSpans = transcript
        ? transcriptToolSpans(payload, turn, transcript, agentSpanId)
        : [];
      return {
        spans: [span, ...llmSpans, ...toolSpans],
        compatibilityEvents,
        workflowName: workflowName(turn),
      };
    }

    case "PreCompact":
    case "PostCompact": {
      const turn = ensureTurnState(payload, state, now);
      const phase = eventName === "PreCompact" ? "before" : "after";
      const span = createChildSpan(
        payload,
        turn,
        `compact:${phase}:${payload.trigger ?? "unknown"}:${now}`,
        `context_compaction_${phase}`,
        now,
        now,
        [
          attrString("neatlogs.span.kind", "CHAIN"),
          attrString("neatlogs.input.value", payload.trigger),
          attrString("neatlogs.output.value", phase),
        ],
      );
      return { spans: [span], workflowName: workflowName(turn) };
    }

    case "Stop": {
      const turn = ensureTurnState(payload, state, now);
      const session = readSessionState(payload, state);
      const spans: OtlpSpan[] = [];
      const transcript = payload.transcript_path
        ? parseCodexTranscriptWithRetry(payload.transcript_path, turn.turnId)
        : undefined;
      if (transcript && transcript.phases.length > 0) {
        spans.push(...transcriptLLMSpans(payload, turn, transcript));
      } else if (payload.last_assistant_message) {
        spans.push(
          createChildSpan(
            payload,
            turn,
            `llm:${bytesToHex(deterministicId(payload.last_assistant_message, 8))}`,
            payload.model ?? turn.model ?? "codex",
            now,
            now,
            [
              attrString("neatlogs.span.kind", "LLM"),
              attrString("neatlogs.llm.request_type", "generateText"),
              attrString("neatlogs.llm.model_name", payload.model ?? turn.model),
              attrString("neatlogs.llm.provider", "openai"),
              attrString("neatlogs.input.value", turn.prompt),
              attrString("neatlogs.output.value", payload.last_assistant_message),
            ],
            { code: SpanStatusCode.OK },
          ),
        );
      }
      spans.push(...rootAndCompletionSpans(payload, config, turn, now, transcript, session));
      state.write(payload.session_id, turnStateKey(turn.turnId), { ...turn, completed: true });
      return { spans, workflowName: workflowName(turn) };
    }

    case "SessionEnd": {
      const active = activeTurn(state, payload.session_id);
      if (!active) return { spans: [], cleanupSession: true };
      const turn = state.read<TurnState>(payload.session_id, turnStateKey(active.turnId));
      if (!turn) return { spans: [], cleanupSession: true };
      if (turn.completed) {
        return {
          spans: [sessionEndSpan(payload, turn, now)],
          workflowName: workflowName(turn),
          cleanupSession: true,
        };
      }
      const session = readSessionState(payload, state);
      const transcript = payload.transcript_path
        ? parseCodexTranscript(payload.transcript_path, turn.turnId)
        : undefined;
      return {
        spans: [
          ...(transcript ? transcriptLLMSpans(payload, turn, transcript) : []),
          ...rootAndCompletionSpans(payload, config, turn, now, transcript, session),
          sessionEndSpan(payload, turn, now),
        ],
        workflowName: workflowName(turn),
        cleanupSession: true,
      };
    }

    default:
      return assertNever(eventName);
  }
}
