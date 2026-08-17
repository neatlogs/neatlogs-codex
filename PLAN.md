# Neatlogs Codex implementation plan

## Goal

Build a standalone TypeScript package that observes Codex lifecycle hooks and exports prompts, tool calls, responses, subagents, compaction events, and session metadata to Neatlogs as OTLP traces.

The package must remain observational: failures in Neatlogs configuration, local state, or export must never block, approve, deny, rewrite, or continue a Codex operation.

## Distribution

The repository will support two installation paths:

1. An npm CLI that registers owned hook entries in `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`.
2. A Codex plugin containing `.codex-plugin/plugin.json` and `hooks/hooks.json`, with hook commands resolved through `${PLUGIN_ROOT}` and writable data stored under `${PLUGIN_DATA}`.

The installer must preserve unrelated hooks, be idempotent, detect inline `[hooks]` configuration before creating a same-layer `hooks.json`, and explain the `/hooks` trust-review step.

## Event mapping

| Codex event | Neatlogs representation |
| --- | --- |
| `SessionStart` | Cache session model and lifecycle state for later semantic spans |
| `UserPromptSubmit` | Open one turn trace using `session_id` and `turn_id` |
| `PreToolUse` | Record tool start time and input |
| `PostToolUse` | Emit a tool span with input, response, status, and duration |
| `PermissionRequest` | Emit a TOOL span whose output records that permission was requested |
| `SubagentStart` | Emit a `TaskCreated` WORKFLOW span and record deterministic agent identity |
| `SubagentStop` | Emit the AGENT span, task ID, duration, and output |
| `PreCompact` | Emit a pre-compaction lifecycle event |
| `PostCompact` | Emit a post-compaction lifecycle event |
| `Stop` | Parse bounded transcript metadata and emit LLM phases, the final response, turn root, and completion marker |
| `SessionEnd` | Flush pending data and clean state for the current session |

Codex does not emit Claude Code's separate `PostToolUseFailure`, `TaskCreated`, `TaskCompleted`, `PermissionDenied`, `StopFailure`, or `InstructionsLoaded` hooks. Supported equivalents are derived from documented Codex hooks and represented with the same Neatlogs semantic attributes as `neatlogs-claude-code`; unsupported hook names are never registered or invented.

## Trace model

- Derive the trace ID deterministically from `session_id` and `turn_id`.
- Use one root `WORKFLOW` span per user turn.
- Derive tool span IDs from `tool_use_id` and agent span IDs from `agent_id`.
- Group turns with `neatlogs.session.id`; use Codex `turn_id` internally for deterministic IDs rather than exporting a platform-unsupported field.
- Set resource metadata for `service.name=neatlogs.codex` and package version, and place model/provider data on their established span attributes.
- Emit per-request LLM token usage, cache usage, reasoning tokens, effort,
  available reasoning summaries, duration, and time to first token from the
  transcript referenced by the hook payload.
- Restrict emitted span attributes to the semantic vocabulary already used by `neatlogs-claude-code`, including `neatlogs.workflow_name`, `neatlogs.task_id`, `neatlogs.tool.*`, `neatlogs.agent.name`, input/output fields, and `error.message`.
- Emit `neatlogs.trace.complete` only when the turn reaches its final stop or the session-end fallback closes it.

Hosted tools that do not use Codex's local function-tool hook path are outside v1 coverage. Tool calls made inside concurrent subagents must not be assigned to an agent unless the documented payload provides an unambiguous relationship.

## Runtime architecture

Use a spool-first design so hook commands do only bounded local work:

1. Read and validate the JSON object from stdin.
2. Persist the event or timing state under a session-scoped directory.
3. Start or notify a background drain that exports queued OTLP spans.
4. Exit successfully without writing to stdout.

Hook mode must reserve stdout for Codex protocol output and therefore emit nothing. Diagnostics belong on stderr or in a restrictive debug file. Network errors are fail-open and remain retryable from the local spool.

`SessionEnd` has a short execution window, so it should perform only a bounded flush and leave any durable queued events for the next drain.

## Proposed source layout

```text
src/
├── cli.ts
├── setup.ts
├── hook-handler.ts
├── codex-events.ts
├── compatibility-events.ts
├── event-mapper.ts
├── transcript.ts
├── state-store.ts
├── spool.ts
├── config.ts
├── trace-shipper.ts
└── package-info.ts
```

Reuse the proven OTLP protobuf encoder and configuration conventions from
`neatlogs-claude-code`, but keep the Codex event mapper and transcript parser
independent. Codex documents its transcript path as a convenience rather than a
stable hook interface, so parsing must be bounded, defensive, version-tolerant,
and optional. Hook-native fields remain the fallback when transcript enrichment
is unavailable.

## CLI

```text
neatlogs-codex setup [--global|--project] [--api-key KEY]
neatlogs-codex uninstall [--global|--project]
neatlogs-codex status
neatlogs-codex doctor
neatlogs-codex hook
neatlogs-codex --version
```

Configuration should continue to support `NEATLOGS_API_KEY`, `NEATLOGS_ENDPOINT`, `NEATLOGS_USER_ID`, and `NEATLOGS_DEBUG`, with a shared user configuration file at `~/.config/neatlogs/config.json`. Secret-bearing files and debug output must use restrictive permissions.

## Testing

- Unit fixtures for every documented hook event and output shape.
- Golden tests for the resulting OTLP span graph and deterministic IDs.
- Installer tests covering merge, repeat setup, uninstall, malformed input, existing `hooks.json`, and inline TOML hook detection.
- Concurrency tests for parallel tools, subagents, and background hook delivery.
- Failure tests for missing keys, HTTP 401, retryable errors, timeouts, interrupted drains, and session-end recovery.
- Privacy tests for payload limits, secret redaction, file modes, and zero stdout in hook mode.
- Manual Codex E2E coverage for Bash, `apply_patch`, MCP tools, code-mode nested calls, tool failure, compaction, resume, subagents, and session termination.
- An isolated `npm pack` smoke test proving the published artifact contains a self-sufficient CLI, plugin manifest, and hook definitions.

## Delivery phases

1. Add the build system, event types, fixtures, and shared transport primitives.
2. Implement the spool, deterministic trace model, and event mapper.
3. Implement setup, uninstall, status, doctor, and trust-review guidance.
4. Add the bundled `hooks/hooks.json` and verify plugin installation.
5. Complete automated and manual E2E testing against Neatlogs ingestion.
6. Remove `private` from `package.json`, publish a beta, validate production traces, and promote to stable.

## Definition of done

- Setup and uninstall are idempotent and preserve user configuration.
- Hook failures never change Codex behavior.
- Hook mode produces no stdout.
- Every captured turn has a deterministic trace, root span, session ID, and completion path.
- Network interruption does not lose locally accepted events.
- Plugin and npm package versions come from one release source.
- The packed artifact passes plugin validation and end-to-end trace verification.
