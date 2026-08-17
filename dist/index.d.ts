interface NeatlogsConfig {
    apiKey: string;
    endpoint: string;
    userId: string;
    debug: boolean;
}
interface ConfigFile {
    api_key?: string;
    endpoint?: string;
    user_id?: string;
    debug?: boolean;
}
declare function getConfigPath(home?: string): string;
declare function loadConfig(env?: NodeJS.ProcessEnv, path?: string): NeatlogsConfig;
declare function updateConfig(patch: Partial<ConfigFile>, path?: string): void;

interface OtlpKeyValue {
    key: string;
    value: {
        stringValue?: string;
        intValue?: string;
        doubleValue?: number;
        boolValue?: boolean;
    };
}
interface OtlpSpan {
    traceId: Uint8Array;
    spanId: Uint8Array;
    parentSpanId?: Uint8Array;
    name: string;
    kind: number;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: OtlpKeyValue[];
    status?: {
        code: number;
        message?: string;
    };
}
type ExportResult = "success" | "retryable" | "terminal";
interface SpanExportClient {
    exportSpans(spans: OtlpSpan[], workflowName?: string): Promise<ExportResult>;
}
interface TraceExporterOptions {
    apiKey: string;
    endpoint: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
declare class TraceExporter implements SpanExportClient {
    private readonly options;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: TraceExporterOptions);
    exportSpans(spans: OtlpSpan[], workflowName?: string): Promise<ExportResult>;
}

interface DrainResult {
    sent: number;
    dropped: number;
    retained: number;
    skipped: boolean;
}
declare class SpanSpool {
    readonly root: string;
    private readonly pendingDirectory;
    private readonly lockPath;
    constructor(root: string);
    enqueue(spans: OtlpSpan[], workflowName?: string): string | undefined;
    pendingFiles(): string[];
    private acquireLock;
    private releaseLock;
    drain(exporter: SpanExportClient, maxBatches?: number): Promise<DrainResult>;
}

declare function getRuntimeRoot(env?: NodeJS.ProcessEnv): string;
declare class StateStore {
    readonly root: string;
    constructor(root?: string);
    sessionDirectory(sessionId: string): string;
    private statePath;
    write<T>(sessionId: string, key: string, value: T): void;
    read<T>(sessionId: string, key: string): T | undefined;
    delete(sessionId: string, key: string): void;
    cleanupSession(sessionId: string): void;
}

interface HookHandlerDependencies {
    config?: NeatlogsConfig;
    state?: StateStore;
    spool?: SpanSpool;
    exporter?: SpanExportClient;
    now?: () => number;
}
declare function handleHook(rawInput?: string, dependencies?: HookHandlerDependencies): Promise<void>;

declare const CODEX_HOOK_EVENTS: readonly ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop"];
type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];
interface CodexHookPayload {
    session_id: string;
    hook_event_name: CodexHookEventName;
    transcript_path?: string | null;
    cwd?: string;
    model?: string;
    turn_id?: string;
    permission_mode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions" | string;
    source?: "startup" | "resume" | "clear" | "compact" | string;
    reason?: string;
    prompt?: string;
    tool_name?: string;
    tool_use_id?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    trigger?: "manual" | "auto" | string;
    agent_id?: string;
    agent_type?: string;
    agent_transcript_path?: string | null;
    stop_hook_active?: boolean;
    last_assistant_message?: string | null;
}

/**
 * Claude Code lifecycle names that do not exist as native Codex hook events.
 * These names are telemetry compatibility labels only and must never be
 * registered in hooks.json.
 */
declare const CODEX_COMPATIBILITY_EVENTS: readonly ["PostToolUseFailure", "TaskCreated", "TaskCompleted", "PermissionDenied", "StopFailure", "InstructionsLoaded"];
type CodexCompatibilityEventName = (typeof CODEX_COMPATIBILITY_EVENTS)[number];
type CodexCompatibilitySupport = "derived" | "conditional" | "unavailable";
interface CodexCompatibilityEventSupport {
    sources: readonly CodexHookEventName[];
    support: CodexCompatibilitySupport;
    note: string;
}
declare const CODEX_COMPATIBILITY_EVENT_SUPPORT: {
    readonly PostToolUseFailure: {
        readonly sources: readonly ["PostToolUse"];
        readonly support: "derived";
        readonly note: "Derived when the documented PostToolUse response reports a tool failure.";
    };
    readonly TaskCreated: {
        readonly sources: readonly ["SubagentStart"];
        readonly support: "derived";
        readonly note: "SubagentStart is the Codex lifecycle equivalent for a spawned unit of work.";
    };
    readonly TaskCompleted: {
        readonly sources: readonly ["SubagentStop"];
        readonly support: "derived";
        readonly note: "SubagentStop is the Codex lifecycle equivalent for a completed unit of work.";
    };
    readonly PermissionDenied: {
        readonly sources: readonly ["PostToolUse"];
        readonly support: "conditional";
        readonly note: "Derived only when a tool failure explicitly says an approval request was denied.";
    };
    readonly StopFailure: {
        readonly sources: readonly [];
        readonly support: "unavailable";
        readonly note: "Codex exposes no failure-specific stop hook; SessionEnd is not a failure signal.";
    };
    readonly InstructionsLoaded: {
        readonly sources: readonly [];
        readonly support: "unavailable";
        readonly note: "Codex does not disclose which instruction files were loaded.";
    };
};
interface DerivedCodexCompatibilityEvent {
    name: CodexCompatibilityEventName;
    source: CodexHookEventName;
    fidelity: "equivalent" | "inferred";
}
interface CompatibilityDerivationContext {
    toolError?: string;
}
declare function deriveCodexCompatibilityEvents(payload: CodexHookPayload, context?: CompatibilityDerivationContext): DerivedCodexCompatibilityEvent[];

interface MapResult {
    spans: OtlpSpan[];
    compatibilityEvents?: DerivedCodexCompatibilityEvent[];
    workflowName?: string;
    cleanupSession?: boolean;
}
declare function mapHookEvent(payload: CodexHookPayload, config: NeatlogsConfig, state: StateStore, now?: number): MapResult;

type HookScope = "global" | "project";
interface SetupStatus {
    scope: HookScope;
    hooksPath: string;
    hooksFileExists: boolean;
    registeredEvents: CodexHookEventName[];
    apiKeyConfigured: boolean;
    inlineHooksDetected: boolean;
}
declare function registerHooks(scope: HookScope, options?: {
    projectDirectory?: string;
    home?: string;
    command?: string;
}): string;
declare function unregisterHooks(scope: HookScope, options?: {
    projectDirectory?: string;
    home?: string;
}): {
    hooksPath: string;
    removed: number;
};
declare function inspectSetup(scope: HookScope, options?: {
    projectDirectory?: string;
    home?: string;
    env?: NodeJS.ProcessEnv;
}): SetupStatus;

interface CodexTokenUsage {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
}
interface CodexLLMPhase {
    inputs: unknown[];
    text: string;
    reasoningSummary: string;
    toolCalls: string[];
    usage: CodexTokenUsage;
    hasReasoning: boolean;
    startMs?: number;
    endMs?: number;
}
interface CodexTranscriptToolCall {
    callId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    startMs?: number;
    endMs?: number;
}
interface CodexTranscriptSessionInfo {
    threadId?: string;
    parentThreadId?: string;
    threadSource?: string;
    isSubagent: boolean;
}
interface CodexTranscriptSummary {
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
declare function inspectCodexTranscriptSession(transcriptPath: string): CodexTranscriptSessionInfo | undefined;
declare function parseCodexTranscript(transcriptPath: string, requestedTurnId?: string): CodexTranscriptSummary | undefined;
declare function parseCodexTranscriptWithRetry(transcriptPath: string, turnId?: string): CodexTranscriptSummary | undefined;

export { CODEX_COMPATIBILITY_EVENTS, CODEX_COMPATIBILITY_EVENT_SUPPORT, type CodexCompatibilityEventName, type CodexCompatibilityEventSupport, type CodexCompatibilitySupport, type CodexHookEventName, type CodexHookPayload, type CodexLLMPhase, type CodexTokenUsage, type CodexTranscriptSessionInfo, type CodexTranscriptSummary, type CodexTranscriptToolCall, type DerivedCodexCompatibilityEvent, type NeatlogsConfig, type OtlpKeyValue, type OtlpSpan, SpanSpool, StateStore, TraceExporter, deriveCodexCompatibilityEvents, getConfigPath, getRuntimeRoot, handleHook, inspectCodexTranscriptSession, inspectSetup, loadConfig, mapHookEvent, parseCodexTranscript, parseCodexTranscriptWithRetry, registerHooks, unregisterHooks, updateConfig };
