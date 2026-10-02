import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, validateProposal } from './monitor.mjs';
import { isolatedCode } from './isolation.mjs';

if (process.env.GITHUB_ACTIONS === 'true' && process.env.COMPAT_UNPRIVILEGED !== 'true') {
  throw new Error('Hosted generated-patch validation requires unprivileged execution');
}

async function run(file, args, env = {}) {
  return new Promise((done) => {
    let output = '';
    const child = spawn(file, args, {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: tmpdir(), CI: 'true', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', (error) => done({ code: -1, output: error.message }));
    child.on('close', (code) => done({ code: code ?? -1, output }));
  });
}

const reportPath = join(root, 'compatibility-report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (process.env.COMPAT_UNPRIVILEGED === 'true') {
  await chmod(root, 0o755);
  const protectedWorkspace = await run('sudo', ['-n', '-u', 'nobody', '--', 'test', '!', '-w', root]);
  if (protectedWorkspace.code !== 0) throw new Error('Unprivileged validation user can write the workspace');
}
const commit = await run('git', ['rev-parse', 'HEAD']);
if (commit.code !== 0 || commit.output.trim() !== report.baseCommit) {
  throw new Error('Validation checkout differs from the captured CLI evidence commit');
}

if (report.proposal?.status === 'pending-validation') {
  const protectedDir = await mkdtemp(join(tmpdir(), 'neatlogs-codex-trusted-'));
  await chmod(protectedDir, 0o755);
  try {
    const trustedProbe = join(root, '.compatibility/trusted-probe.mjs');
    const baselineFixture = join(protectedDir, 'baseline.jsonl');
    const latestFixture = join(protectedDir, 'latest.jsonl');
    await copyFile(join(root, 'dist/compatibility-probe.js'), trustedProbe);
    await copyFile(join(root, 'compatibility-fixtures/baseline.jsonl'), baselineFixture);
    await copyFile(join(root, 'compatibility-fixtures/latest.jsonl'), latestFixture);
    const protectedFiles = [trustedProbe, baselineFixture, latestFixture];
    for (const path of protectedFiles) await chmod(path, 0o444);
    if (process.env.COMPAT_UNPRIVILEGED === 'true') {
      for (const path of protectedFiles) {
        const access = await run('sudo', ['-n', '-u', 'nobody', '--', 'test', '!', '-w', path]);
        if (access.code !== 0) throw new Error(`Unprivileged validation user can alter ${path}`);
      }
    }
    const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
    const hashes = await Promise.all(protectedFiles.map(digest));
    async function verifyIntegrity() {
      const now = await Promise.all(protectedFiles.map(digest));
      if (now.some((hash, index) => hash !== hashes[index])) {
        throw new Error('Trusted verifier or captured fixtures changed during validation');
      }
    }
    const probeEnv = { COMPAT_UNPRIVILEGED: process.env.COMPAT_UNPRIVILEGED === 'true' ? 'true' : 'false' };
    const baseCode = await isolatedCode();
    let baseline;
    let latest;
    try {
      const cli = join(baseCode, 'dist/cli.js');
      baseline = await run(process.execPath, [trustedProbe, baselineFixture, cli], probeEnv);
      latest = await run(process.execPath, [trustedProbe, latestFixture, cli], probeEnv);
    } finally {
      await rm(baseCode, { recursive: true, force: true });
    }
    await verifyIntegrity();
    if (baseline.code !== 0) {
      report.proposal = { status: 'rejected', reason: 'Captured baseline does not pass in secretless replay' };
    } else if (latest.code === 0) {
      report.proposal = { status: 'rejected', reason: 'Latest captured hooks do not reproduce the candidate regression' };
    } else {
      report.baseline.hookLog = baselineFixture;
      report.latest.hookLog = latestFixture;
      report.proposal = await validateProposal(report, report.gemini, protectedDir, trustedProbe, verifyIntegrity);
      delete report.baseline.hookLog;
      delete report.latest.hookLog;
    }
    await verifyIntegrity();
  } finally {
    await rm(protectedDir, { recursive: true, force: true });
    await rm(join(root, '.compatibility/trusted-probe.mjs'), { force: true });
  }
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Secretless patch validation: ${report.proposal?.status ?? 'not proposed'}\n`);
