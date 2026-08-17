import type { CodexHookEventName, CodexHookPayload } from "./codex-events";

/**
 * Claude Code lifecycle names that do not exist as native Codex hook events.
 * These names are telemetry compatibility labels only and must never be
 * registered in hooks.json.
 */
export const CODEX_COMPATIBILITY_EVENTS = [
  "PostToolUseFailure",
  "TaskCreated",
  "TaskCompleted",
  "PermissionDenied",
  "StopFailure",
  "InstructionsLoaded",
] as const;

export type CodexCompatibilityEventName = (typeof CODEX_COMPATIBILITY_EVENTS)[number];
export type CodexCompatibilitySupport = "derived" | "conditional" | "unavailable";

export interface CodexCompatibilityEventSupport {
  sources: readonly CodexHookEventName[];
  support: CodexCompatibilitySupport;
  note: string;
}

export const CODEX_COMPATIBILITY_EVENT_SUPPORT = {
  PostToolUseFailure: {
    sources: ["PostToolUse"],
    support: "derived",
    note: "Derived when the documented PostToolUse response reports a tool failure.",
  },
  TaskCreated: {
    sources: ["SubagentStart"],
    support: "derived",
    note: "SubagentStart is the Codex lifecycle equivalent for a spawned unit of work.",
  },
  TaskCompleted: {
    sources: ["SubagentStop"],
    support: "derived",
    note: "SubagentStop is the Codex lifecycle equivalent for a completed unit of work.",
  },
  PermissionDenied: {
    sources: ["PostToolUse"],
    support: "conditional",
    note: "Derived only when a tool failure explicitly says an approval request was denied.",
  },
  StopFailure: {
    sources: [],
    support: "unavailable",
    note: "Codex exposes no failure-specific stop hook; SessionEnd is not a failure signal.",
  },
  InstructionsLoaded: {
    sources: [],
    support: "unavailable",
    note: "Codex does not disclose which instruction files were loaded.",
  },
} as const satisfies Record<CodexCompatibilityEventName, CodexCompatibilityEventSupport>;

export interface DerivedCodexCompatibilityEvent {
  name: CodexCompatibilityEventName;
  source: CodexHookEventName;
  fidelity: "equivalent" | "inferred";
}

export interface CompatibilityDerivationContext {
  toolError?: string;
}

function isExplicitApprovalDenial(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim();
  const denial = "(?:denied|declined|rejected)";
  const actor = "(?:user|approval(?: request)?|authorization request)";
  return new RegExp(`\\b${actor}\\b.{0,48}\\b${denial}\\b`, "i").test(normalized)
    || new RegExp(`\\b${denial}\\b.{0,48}\\b${actor}\\b`, "i").test(normalized);
}

export function deriveCodexCompatibilityEvents(
  payload: CodexHookPayload,
  context: CompatibilityDerivationContext = {},
): DerivedCodexCompatibilityEvent[] {
  switch (payload.hook_event_name) {
    case "PostToolUse": {
      if (!context.toolError) return [];
      const events: DerivedCodexCompatibilityEvent[] = [
        {
          name: "PostToolUseFailure",
          source: "PostToolUse",
          fidelity: "equivalent",
        },
      ];
      if (isExplicitApprovalDenial(context.toolError)) {
        events.push({
          name: "PermissionDenied",
          source: "PostToolUse",
          fidelity: "inferred",
        });
      }
      return events;
    }

    case "SubagentStart":
      return [{ name: "TaskCreated", source: "SubagentStart", fidelity: "equivalent" }];

    case "SubagentStop":
      return [{ name: "TaskCompleted", source: "SubagentStop", fidelity: "equivalent" }];

    default:
      return [];
  }
}
