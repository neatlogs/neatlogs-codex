import { appendFile } from 'node:fs/promises';

// This is only installed into the disposable Codex home used by the canary.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString('utf8');
if (raw.length <= 100_000 && process.env.COMPAT_HOOK_LOG) {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!['SessionStart', 'UserPromptSubmit', 'Stop'].includes(input.hook_event_name)) process.exit(0);
  const synthetic = {
    session_id: typeof input.session_id === 'string' ? 'compat-session' : null,
    turn_id: typeof input.turn_id === 'string' ? 'compat-turn' : undefined,
    hook_event_name: input.hook_event_name,
    source: typeof input.source === 'string' ? 'startup' : undefined,
    model: typeof input.model === 'string' ? 'compat-model' : undefined,
    permission_mode: typeof input.permission_mode === 'string' ? 'default' : undefined,
    prompt: input.hook_event_name === 'UserPromptSubmit'
      ? typeof input.prompt === 'string' ? 'Reply with the single word OK.' : input.prompt == null ? input.prompt : {}
      : undefined,
    last_assistant_message: input.hook_event_name === 'Stop'
      ? typeof input.last_assistant_message === 'string' ? 'OK' : input.last_assistant_message == null ? input.last_assistant_message : {}
      : undefined,
  };
  await appendFile(process.env.COMPAT_HOOK_LOG, `${JSON.stringify(synthetic)}\n`, { mode: 0o600 });
}
