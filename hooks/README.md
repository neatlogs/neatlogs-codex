# Hook bundle

`hooks.json` registers the documented Codex lifecycle events used by Neatlogs. Plugin commands resolve the bundled CLI through `${PLUGIN_ROOT}` and keep hook-mode stdout empty.

Codex requires users to review and trust non-managed hook definitions through `/hooks` before they run.
