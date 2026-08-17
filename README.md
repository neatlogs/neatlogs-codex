# @neatlogs/codex

Automatic Neatlogs observability for Codex sessions through lifecycle hooks.

Current release: `0.1.0`

## Install

Requires Node.js 18 or newer.

```bash
npm install -g @neatlogs/codex@latest
neatlogs-codex --version
```

To update an existing installation:

```bash
npm install -g @neatlogs/codex@latest
```

## Configure the API key and hooks

Global setup is recommended because it traces Codex in every project:

```bash
neatlogs-codex setup --global --api-key YOUR_PROJECT_KEY
neatlogs-codex status --global
neatlogs-codex doctor --global
```

The setup command stores the key in `~/.config/neatlogs/config.json` with
user-only permissions and registers all supported lifecycle hooks in
`~/.codex/hooks.json`. Running the command again updates the key and refreshes
the owned hook entries without removing unrelated hooks.

For only the current repository, run this from its root instead:

```bash
neatlogs-codex setup --project --api-key YOUR_PROJECT_KEY
neatlogs-codex doctor --project
```

This writes `<repo>/.codex/hooks.json`; the API key remains in the shared
Neatlogs config file.

## Start Codex and view traces

Start a new Codex session after setup:

```bash
codex
```

Open `/hooks` inside Codex and review and trust the Neatlogs hook definitions.
Submit a prompt, wait for the response to finish, then open
[Neatlogs Traces](https://app.neatlogs.com/traces). Each main-thread user prompt
is represented as one trace/turn. Subagent work is nested inside its parent turn
instead of creating an additional conversation turn.

## Verification prompts

Run these in order in a fresh Codex session to exercise the principal mappings.

1. LLM metadata, reasoning, and I/O:

   ```text
   Without using tools, reason carefully about three risks of lifecycle-hook observability and give a concise recommendation.
   ```

2. Successful tool call and multiple LLM phases:

   ```text
   Use Bash exactly once to run `pwd && git branch --show-current && git rev-parse --short HEAD`, then summarize the result.
   ```

3. Failed tool call:

   ```text
   Use Bash exactly once to run `sh -c 'echo expected-test-failure >&2; exit 7'`. Do not retry; explain that this was an intentional test.
   ```

4. Permission lifecycle:

   ```text
   Use Bash to run `curl -I https://example.com`. If network access is sandbox-blocked, request elevated execution exactly once, then report what happened.
   ```

5. `apply_patch` lifecycle:

   ```text
   Use apply_patch to create neatlogs-smoke-test.txt containing "temporary smoke test", inspect it, then use apply_patch to delete it. Leave no repository changes behind.
   ```

6. Subagent nesting and turn scoping:

   ```text
   Spawn exactly one subagent. Ask it to inspect package.json, use Bash exactly once to run `pwd`, and report the package name and working directory. Then summarize its result. Do not perform the inspection yourself.
   ```

After prompt 6, the Neatlogs session should contain exactly six turns. The last
turn should contain `TaskCreated`, an AGENT span, nested LLM spans, and the nested
Bash span. Root execution/session fields should remain on the WORKFLOW span;
LLM, TOOL, and AGENT spans contain only their relevant fields.

To exercise compaction, run `/compact`, then submit another prompt. Exit Codex
normally to exercise `SessionEnd`. Some values, including cache usage, plaintext
reasoning summaries, and permission events, appear only when Codex emits them.

## Commands

```bash
neatlogs-codex setup [--global|--project] [--api-key KEY]
neatlogs-codex status [--global|--project]
neatlogs-codex doctor [--global|--project]
neatlogs-codex uninstall [--global|--project]
neatlogs-codex --version
```

`neatlogs-codex hook` is the hook runtime entry point and is normally invoked
by Codex rather than manually.

## Uninstall

```bash
neatlogs-codex uninstall --global
npm uninstall -g @neatlogs/codex
```

Use `--project` instead of `--global` when the hooks were registered only in the
current repository. Uninstalling hooks does not delete the shared API-key file.

## Troubleshooting

- Run `neatlogs-codex doctor --global` and confirm that an API key and all hook
  events are registered.
- Restart Codex after installing or updating the package.
- Open `/hooks` and confirm the Neatlogs definitions are trusted.
- If global npm installation reports `EACCES`, use a Node version manager or a
  user-writable npm prefix.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The generated `dist/` directory is part of the plugin artifact because bundled hook commands execute `dist/cli.js` directly through `${PLUGIN_ROOT}`.

The current runtime:

- maps documented Codex session, turn, tool, permission, compaction, subagent, and stop hooks;
- keeps exactly one trace per main-thread user turn; subagent hook streams never
  become sibling conversation turns;
- defensively enriches LLM spans from Codex's transcript with per-request input,
  output, cached, cache-write, and reasoning tokens;
- records reasoning effort, available reasoning summaries, tool calls, duration,
  and time to first token without exporting encrypted reasoning content;
- emits Claude-compatible derived telemetry for tool failures and subagent task lifecycle events;
- derives deterministic trace, root, tool, and agent IDs;
- exports protobuf OTLP traces to Neatlogs;
- keeps retryable batches in a restrictive local spool;
- redacts common secret-bearing keys from captured tool input and output;
- never writes hook diagnostics or protocol output to stdout.

## Claude event compatibility

Codex has 11 native hook events. Unsupported Claude event names are not placed in
`hooks.json`; Codex would never emit them. Instead, the runtime maps supported
equivalents onto the same Neatlogs semantic attributes used by the Claude Code
package and exports the compatibility result from the package API.

| Claude Code event | Documented Codex source | Coverage |
| --- | --- | --- |
| `PostToolUseFailure` | `PostToolUse` | Derived when the response reports failure |
| `TaskCreated` | `SubagentStart` | Derived task-lifecycle equivalent |
| `TaskCompleted` | `SubagentStop` | Derived task-lifecycle equivalent |
| `PermissionDenied` | `PostToolUse` | Conditional; only with explicit approval-denial evidence |
| `StopFailure` | None | Unavailable; `SessionEnd` also represents normal endings |
| `InstructionsLoaded` | None | Unavailable; loaded instruction files are not disclosed |

Derived telemetry uses established fields such as `neatlogs.span.kind`,
`neatlogs.workflow_name`, `neatlogs.task_id`, `neatlogs.tool.*`,
`neatlogs.agent.*`, `neatlogs.input.value`, `neatlogs.output.value`, and
`error.message`. It does not emit compatibility-only `neatlogs.codex.*`
attributes that the platform's simplified view would discard. The exported
`CODEX_COMPATIBILITY_EVENT_SUPPORT` manifest still includes all six names,
including the two that cannot be inferred safely.

## LLM metadata

Codex hooks directly expose the active model and a transcript path. Token usage,
reasoning effort, timing, and reasoning summaries are read defensively from that
turn's transcript and emitted on individual LLM spans. The parser is bounded,
tolerates malformed or partially flushed JSONL records, and falls back to the
documented `last_assistant_message` hook field when enrichment is unavailable.

Standard LLM fields use the platform's existing `neatlogs.llm.*` attributes:
model, provider, effort, prompt/completion/total/reasoning tokens, cache-read and
cache-write tokens, duration, time to first token, tool calls, thinking summary,
and `has_thinking`. Subagent transcripts receive the same enrichment and their
LLM and tool spans are parented to the corresponding agent span inside the
main-thread turn trace. Codex subagent hook streams reuse the parent session ID,
so the handler identifies their separate transcript ownership and leaves turn
creation to the parent thread's `UserPromptSubmit`/`Stop` pair.

Additional runtime context is sent through the backend-supported
`neatlogs.workflow.*` and `neatlogs.session.*` namespaces. Root WORKFLOW spans
receive cwd, permission and approval modes, collaboration and sandbox modes,
network access, turn status/error, session source/client, CLI version,
originator, git branch/commit, and session-end reason. LLM spans receive the
runtime values relevant to the model request, including effort, model context
window, and time to first token. The backend strips the leading `neatlogs.` and
stores these custom fields in `spans_simplified.span_metadata`.

Codex stores raw reasoning as encrypted content. This package never exports that
encrypted value; it exports only a plaintext reasoning summary when Codex makes
one available, plus the reasoning-token count and `has_thinking` indicator. It
also does not export transcript paths, agent transcript paths, base instructions,
workspace-root lists, writable-root lists, repository URLs, or account/rate-limit
data.

Codex documents the transcript format as unstable. Missing or changed transcript
fields therefore degrade enrichment only; documented lifecycle-hook tracing still
continues.

## References

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [Implementation plan](./PLAN.md)

## Publishing

The npm, package-lock, and Codex plugin versions must stay aligned. The package
uses public access for the `@neatlogs` scope and reruns typecheck, tests, and the
production build during `npm publish`:

```bash
npm login
npm whoami
npm publish
```

npm may also request the account's two-factor authentication code.
