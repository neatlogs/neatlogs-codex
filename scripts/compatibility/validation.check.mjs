import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A controlled synthetic upstream schema change exercises the complete
// secretless gate. It is a gate test, not evidence of a real Codex regression.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), 'neatlogs-codex-red-green-'));
const checkout = join(temporary, 'checkout');

async function run(file, args, options = {}) {
  return new Promise((done, reject) => {
    let output = '';
    const child = spawn(file, args, {
      cwd: options.cwd ?? checkout,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => done({ code, output }));
  });
}

try {
  await chmod(temporary, 0o755);
  const clone = await run('git', ['clone', '--quiet', '--no-hardlinks', root, checkout], { cwd: temporary });
  if (clone.code !== 0) throw new Error(`Scratch clone failed: ${clone.output}`);
  await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'));
  // During local development, include the current validation scripts before
  // they have been committed. CI checks out the same versions already.
  for (const name of ['isolation.mjs', 'validate.mjs', 'monitor.mjs']) {
    await copyFile(join(root, 'scripts/compatibility', name), join(checkout, 'scripts/compatibility', name));
  }
  const sourcePath = join(checkout, 'src/event-mapper.ts');
  const testPath = join(checkout, 'test/event-mapper.test.ts');
  let source = await readFile(sourcePath, 'utf8');
  source = source.replace('function errorText(value: unknown): string | undefined {', 'function assistantMessage(value: unknown): string | undefined {\n  return typeof value === "string" ? value : safeStringify(value);\n}\n\nfunction errorText(value: unknown): string | undefined {');
  source = source.replaceAll('payload.last_assistant_message ?? transcript?.lastAssistantMessage', 'assistantMessage(payload.last_assistant_message) ?? transcript?.lastAssistantMessage');
  source = source.replace('      } else if (payload.last_assistant_message) {', '      } else if (assistantMessage(payload.last_assistant_message)) {');
  source = source.replace('deterministicId(payload.last_assistant_message, 8)', 'deterministicId(assistantMessage(payload.last_assistant_message)!, 8)');
  source = source.replace('attrString("neatlogs.output.value", payload.last_assistant_message)', 'attrString("neatlogs.output.value", assistantMessage(payload.last_assistant_message))');
  await writeFile(sourcePath, source);
  const test = await readFile(testPath, 'utf8');
  const syntheticTest = `\n  it("handles a structured synthetic Stop result", () => {\n    mapHookEvent(payload("UserPromptSubmit", { prompt: "OK" }), config, state, 1000);\n    const result = mapHookEvent(payload("Stop", { last_assistant_message: {} as unknown as string }), config, state, 1100);\n    expect(result.spans.some((span) => attribute(span, "neatlogs.span.kind") === "WORKFLOW")).toBe(true);\n  });\n`;
  const end = test.lastIndexOf('\n});');
  if (end < 0) throw new Error('Could not insert controlled test');
  await writeFile(testPath, test.slice(0, end) + syntheticTest + test.slice(end));
  const diff = await run('git', ['diff', '--', 'src/event-mapper.ts', 'test/event-mapper.test.ts']);
  if (diff.code !== 0 || !diff.output.includes('diff --git')) throw new Error('Could not generate controlled patch');
  const restore = await run('git', ['restore', '--', 'src/event-mapper.ts', 'test/event-mapper.test.ts']);
  if (restore.code !== 0) throw new Error('Could not restore scratch baseline');
  const fixtureDir = join(checkout, 'compatibility-fixtures');
  await mkdir(fixtureDir);
  const events = (message) => [
    { session_id: 'compat-session', hook_event_name: 'SessionStart', source: 'startup' },
    { session_id: 'compat-session', turn_id: 'compat-turn', hook_event_name: 'UserPromptSubmit', prompt: 'Reply with the single word OK.' },
    { session_id: 'compat-session', turn_id: 'compat-turn', hook_event_name: 'Stop', last_assistant_message: message },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(join(fixtureDir, 'baseline.jsonl'), events('OK'));
  await writeFile(join(fixtureDir, 'latest.jsonl'), events({}));
  const base = await run('git', ['rev-parse', 'HEAD']);
  const report = {
    schemaVersion: 1,
    package: '@openai/codex',
    baselineVersion: '0.160.0',
    latestVersion: '0.161.0',
    baseCommit: base.output.trim(),
    relation: 'newer',
    classification: 'candidate-regression',
    baseline: { status: 'pass' },
    latest: { status: 'fail' },
    proposal: { status: 'pending-validation' },
    gemini: { status: 'completed', decision: 'propose_fix', patch: diff.output },
  };
  await writeFile(join(checkout, 'compatibility-report.json'), `${JSON.stringify(report)}\n`);
  const validated = await run(process.execPath, ['scripts/compatibility/validate.mjs']);
  if (validated.code !== 0) throw new Error(`Controlled red-green validation crashed: ${validated.output.slice(-1500)}`);
  const result = JSON.parse(await readFile(join(checkout, 'compatibility-report.json'), 'utf8'));
  if (result.proposal?.status !== 'validated') {
    throw new Error(`Controlled red-green validation did not pass: ${result.proposal?.reason ?? validated.output.slice(-1000)}`);
  }
  process.stdout.write('Controlled synthetic candidate passed the secretless red-green validation gate.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
