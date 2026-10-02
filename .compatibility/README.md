# Codex CLI compatibility monitor

The scheduled workflow compares the npm `latest` release of `@openai/codex`
with the exact version in `codex-cli.lock.json`. The recorded `0.160.0` version
was observed through npm and the CLI help output on 2026-10-02. It was **not**
an authenticated hook compatibility pass when recorded.

While npm latest still equals the recorded version, the monitor runs the
recorded-version canary once per schedule to establish and refresh actual hook
evidence. It does not change the lock from a same-version check.

For a newer release, the workflow installs both exact CLI versions in temporary
directories and checks that they start and expose the canary's required flags.
With a `COMPAT_OPENAI_API_KEY` Actions secret, it then runs a disposable,
read-only `codex exec` with vetted user-level hooks. The canary captures
`SessionStart`, `UserPromptSubmit`, and `Stop`, replays their payloads through the
packaged Neatlogs hook command, and requires an encoded workflow span at a
local OTLP sink. The recorder writes bounded synthetic fields for this fixed
canary; only these sanitized records are uploaded to the separate, secretless
patch-validation job. Other hook events, real
tool activity, plugin trust UX, and the unstable transcript format are outside
this canary's scope.

The result is a **candidate regression** only when the baseline live canary
passes and the latest live canary fails. Missing credentials, unavailable model
access, or a failed baseline are **blocked/unverified**, not regressions.
Gemini is called only for a candidate regression. Its finding is advisory.
Gemini may propose a small source/test patch. A separate runner with no Codex,
Gemini, or GitHub write credential applies it. The generated tests and handler
run as a separate unprivileged OS user, unable to edit the captured fixtures or
trusted replay verifier. Baseline replay must remain green and latest replay
must change from red to green through the packaged handler and local OTLP sink.
A regular PR opens only after typecheck, tests, build, and that red-green check
pass. The authenticated live CLI canaries run before the patch; post-patch
validation replays their sanitized payloads. The resulting lock records that
the patched CLI itself has not been rerun live.
The fix PR advances the recorded version. Nothing approves or merges a PR.

Repository setup:

1. Keep **Allow GitHub Actions to create and approve pull requests** enabled.
   This is GitHub's combined setting; the workflow calls create only.
2. Add Actions secret `COMPAT_OPENAI_API_KEY` for the authenticated Codex CLI
   canary. It must be usable for noninteractive Codex inference. Without it,
   each new version produces an explicit blocked result and no fix PR.
3. Add Actions secret `COMPAT_GEMINI_API_KEY` for advisory impact analysis and
   a bounded fix proposal. Without it, deterministic checks still run, but no
   generated patch can be proposed.
4. Add Actions secret `COMPAT_SLACK_WEBHOOK_URL` for Slack outcome alerts. A
   new version opens or updates a GitHub issue even if Slack is not configured.
5. Require human PR review on `main`. The workflow requests `contents: write`,
   `issues: write`, and `pull-requests: write`; it does not approve or merge.
   GitHub may hold CI for a PR created with its default `GITHUB_TOKEN` until a
   maintainer clicks **Approve workflows to run**. This is separate from code
   review approval.

Run **Codex CLI compatibility** manually with its default `dry_run: true` to
exercise discovery and CLI install checks on a branch without passing provider
secrets, creating an issue or PR, or sending Slack. Authenticated canaries and
Gemini proposals run only from the default branch. Scheduled runs use the
default branch and publish an issue for
each new version. Slack sends an alert when a release's classification or fix
state changes, avoiding repeated identical blocked alerts.

Official hook reference: <https://learn.chatgpt.com/docs/hooks>.
