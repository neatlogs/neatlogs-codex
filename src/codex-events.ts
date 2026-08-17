export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

export interface CodexHookPayload {
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

export function isCodexHookPayload(value: unknown): value is CodexHookPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    typeof record.hook_event_name === "string" &&
    CODEX_HOOK_EVENTS.includes(record.hook_event_name as CodexHookEventName)
  );
}
