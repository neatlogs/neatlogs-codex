import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validatePatchShape } from './monitor.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const repository = process.env.GITHUB_REPOSITORY;
const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;

async function run(file, args) {
  return new Promise((done) => {
    let output = '';
    const child = spawn(file, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.on('error', (error) => done({ code: -1, output: error.message }));
    child.on('close', (code) => done({ code: code ?? -1, output }));
  });
}

function outcome(report) {
  if (!report) return 'Workflow failed before it produced a compatibility report.';
  if (report.classification === 'baseline-verified') {
    return 'Recorded Codex CLI version passed the authenticated hook canary; no newer npm release was found. No PR needed.';
  }
  if (report.classification === 'candidate-regression') {
    return report.proposal?.status === 'validated'
      ? 'Latest Codex hook canary regressed against a passing baseline; a proposed fix passed local validation.'
      : 'Latest Codex hook canary regressed against a passing baseline; no validated fix PR is available.';
  }
  if (report.classification === 'no-regression-in-tested-scope') {
    return 'Baseline and latest authenticated hook canaries passed the stated probes; broader compatibility remains unverified. No PR needed.';
  }
  return report.relation === 'same'
    ? 'Recorded Codex CLI version remains unverified because its authenticated hook canary was blocked or incomplete.'
    : 'Compatibility is unverified because the authenticated hook canary was blocked or incomplete.';
}

function alertState(report, publicationError) {
  const blocked = report.baseline?.reason?.includes('COMPAT_OPENAI_API_KEY')
    ? 'missing-key' : report.baseline?.reason?.includes('authentication/access')
      ? 'auth' : report.baseline?.status === 'blocked' ? 'other-block' : 'ready';
  return `${report.classification}:${report.proposal?.status ?? 'none'}:${blocked}:${report.gemini?.status ?? 'none'}:${publicationError ? 'pr-blocked' : 'published'}`;
}

function body(report, prUrl, publicationError) {
  const text = [
    report.relation === 'same'
      ? `@openai/codex recorded version ${report.baselineVersion}; npm latest is unchanged.`
      : `@openai/codex ${report.baselineVersion} → ${report.latestVersion}.`,
    '',
    outcome(report),
    '',
    '| Check | Recorded baseline | Published latest |',
    '| --- | --- | --- |',
    `| Exact CLI install, version and exec flags | ${report.cliSmoke?.baseline?.status ?? 'not tested'} | ${report.cliSmoke?.latest?.status ?? 'not tested'} |`,
    `| Authenticated hook execution and adapter replay | ${report.baseline?.status ?? 'not tested'} | ${report.latest?.status ?? 'not tested'} |`,
    '',
    `Scope: ${report.checkScope}`,
    `Baseline detail: ${report.baseline?.reason ?? 'none'}`,
    `Latest detail: ${report.latest?.reason ?? 'none'}`,
    report.baseline?.reason?.includes('COMPAT_OPENAI_API_KEY')
      ? 'Action: configure the `COMPAT_OPENAI_API_KEY` GitHub Actions secret to enable the authenticated baseline/latest hook canary.'
      : '',
    '',
    report.gemini?.status === 'skipped'
      ? `Gemini: skipped. ${report.gemini.reason}`
      : `Gemini advisory: ${report.gemini?.status ?? 'not run'}; risk ${report.gemini?.risk ?? 'unknown'} (unverified). ${report.gemini?.reason ?? ''}`,
    `Proposed code fix: ${report.proposal?.status ?? 'not proposed'}. ${report.proposal?.reason ?? ''}`,
    prUrl ? `Review PR: ${prUrl}` : 'Review PR: none opened.',
    publicationError ? `PR publication blocked: ${publicationError.slice(0, 500)}` : '',
    '',
    `Evidence and workflow run: ${runUrl}`,
    '',
    'The workflow never approves or merges a PR. The version lock advances only in a validated fix PR.',
    `<!-- compat-state:${alertState(report, publicationError)} -->`,
  ];
  return text.join('\n').slice(0, 30_000);
}

async function publishPr(report, temporary) {
  if (report.proposal?.status !== 'validated') return null;
  const branch = `compat/codex-${report.latestVersion.replace(/[^0-9A-Za-z.-]/g, '-')}`;
  const patchPath = join(root, 'compatibility-proposal.patch');
  const patch = await readFile(patchPath, 'utf8');
  if (!validatePatchShape(patch)) throw new Error('Downloaded patch violates the source/test allowlist');
  const patchHash = createHash('sha256').update(patch).digest('hex');
  const marker = `Compat-Patch-SHA256: ${patchHash}`;
  const current = await run('git', ['rev-parse', 'HEAD']);
  if (current.code !== 0 || current.output.trim() !== report.baseCommit) {
    throw new Error('Publisher checkout does not match the monitored commit');
  }
  const numstat = await run('git', ['apply', '--numstat', patchPath]);
  const patchPaths = numstat.output.trim().split('\n').filter(Boolean).map((line) => line.split('\t').at(-1));
  const headerPaths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map((match) => match[1]);
  if (numstat.code !== 0 || patchPaths.length !== headerPaths.length
      || patchPaths.some((path) => !headerPaths.includes(path))) {
    throw new Error('Downloaded patch paths do not match its validated headers');
  }
  for (const path of patchPaths) {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Downloaded patch targets a non-regular file');
  }
  const applied = await run('git', ['apply', '--check', patchPath]);
  if (applied.code !== 0) throw new Error(`Downloaded patch no longer applies: ${applied.output.slice(-500)}`);
  const resultApply = await run('git', ['apply', patchPath]);
  if (resultApply.code !== 0) throw new Error(`Downloaded patch could not apply: ${resultApply.output.slice(-500)}`);
  const lockPath = join(root, '.compatibility/codex-cli.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.recordedVersion !== report.baselineVersion) throw new Error('Recorded baseline changed since monitoring');
  await writeFile(lockPath, `${JSON.stringify({
    ...lock,
    recordedVersion: report.latestVersion,
    recordedAt: report.generatedAt.slice(0, 10),
    recordedFrom: 'baseline live canary and secretless captured-hook red-green replay of generated fix',
    liveHookCanaryAtRecording: 'patched live CLI not run; captured latest hooks passed after patch',
  }, null, 2)}\n`);
  const changed = await run('git', ['diff', '--name-only']);
  if (changed.code !== 0) throw new Error('Cannot inspect generated changes');
  const paths = changed.output.trim().split('\n').filter(Boolean);
  const allowed = /^(src\/(codex-events|event-mapper|transcript)\.ts|test\/(hook-coverage|event-mapper|transcript)\.test\.ts|dist\/(cli|index|compatibility-probe)\.(js|d\.ts)|\.compatibility\/codex-cli\.lock\.json)$/;
  if (!paths.length || paths.some((path) => !allowed.test(path))) {
    throw new Error(`Generated fix changed unexpected files: ${paths.join(', ')}`);
  }
  const owner = repository.split('/')[0];
  const prior = await run('gh', ['pr', 'list', '-R', repository, '--state', 'open', '--head', `${owner}:${branch}`, '--json', 'url,body,headRefOid,headRepositoryOwner']);
  if (prior.code !== 0) throw new Error(`Cannot inspect prior PRs: ${prior.output}`);
  const existing = JSON.parse(prior.output)[0];
  if (existing) {
    if (existing.headRepositoryOwner?.login !== owner || !existing.body?.includes(marker)) {
      throw new Error(`Existing open PR ${existing.url} has a different owner or patch; review the branch conflict`);
    }
    const fetched = await run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
    const remoteHead = await run('git', ['rev-parse', 'FETCH_HEAD']);
    const base = await run('git', ['merge-base', report.baseCommit, 'FETCH_HEAD']);
    const message = await run('git', ['log', '-1', '--format=%B', 'FETCH_HEAD']);
    if (fetched.code !== 0 || remoteHead.code !== 0 || remoteHead.output.trim() !== existing.headRefOid
        || base.code !== 0 || base.output.trim() !== report.baseCommit
        || message.code !== 0 || !message.output.includes(marker)) {
      throw new Error(`Existing open PR ${existing.url} has a stale or changed head; review the branch conflict`);
    }
    const remoteChanges = await run('git', ['diff', '--name-only', report.baseCommit, 'FETCH_HEAD']);
    const remotePaths = remoteChanges.output.trim().split('\n').filter(Boolean);
    if (remoteChanges.code !== 0 || remotePaths.length !== paths.length
        || remotePaths.some((path) => !paths.includes(path))) {
      throw new Error(`Existing open PR ${existing.url} changes different files; review the branch conflict`);
    }
    for (const path of paths) {
      const remoteFile = await run('git', ['show', `FETCH_HEAD:${path}`]);
      if (remoteFile.code !== 0) throw new Error(`Cannot inspect ${path} in existing PR`);
      const localFile = await readFile(join(root, path), 'utf8');
      const normalize = (content) => {
        if (path !== '.compatibility/codex-cli.lock.json') return content;
        const value = JSON.parse(content);
        delete value.recordedAt;
        return JSON.stringify(value);
      };
      if (normalize(remoteFile.output) !== normalize(localFile)) {
        throw new Error(`Existing open PR ${existing.url} has different content in ${path}; review the branch conflict`);
      }
    }
    return existing.url;
  }
  const branchCheck = await run('git', ['ls-remote', '--heads', 'origin', branch]);
  if (branchCheck.code !== 0 || branchCheck.output.trim()) throw new Error('Fix branch already exists or cannot be checked');
  for (const [file, args] of [
    ['git', ['switch', '-c', branch]],
    ['git', ['add', '--', ...paths]],
    ['git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `fix: adapt Codex hooks for CLI ${report.latestVersion}`, '-m', marker]],
    ['gh', ['auth', 'setup-git']],
    ['git', ['push', 'origin', `HEAD:refs/heads/${branch}`]],
  ]) {
    const result = await run(file, args);
    if (result.code !== 0) throw new Error(`${file} ${args[0]} failed: ${result.output.slice(-500)}`);
  }
  const prBody = join(temporary, 'pr-body.md');
  await writeFile(prBody, [
    `## Codex CLI ${report.latestVersion} compatibility fix`,
    '',
    'The recorded baseline live hook canary passed and the newer CLI canary failed.',
    'Gemini proposed this bounded source/test patch. A secretless runner validated typecheck, tests, build, and red-green replay of captured baseline/latest hook payloads through the packaged handler and local OTLP sink.',
    'The model rationale is advisory; reviewers should verify the behavioral claim and code change.',
    'GitHub may require a maintainer to click “Approve workflows to run” for CI on this GITHUB_TOKEN-created PR. This is separate from approving its code.',
    '',
    `Evidence: ${runUrl}`,
    '',
    'This is a regular PR for human review. The workflow does not approve or merge it.',
    '',
    `<!-- ${marker} -->`,
  ].join('\n'));
  const created = await run('gh', ['pr', 'create', '-R', repository, '--base', process.env.GITHUB_EVENT_REPOSITORY_DEFAULT_BRANCH || 'main', '--head', branch,
    '--title', `fix: Codex CLI ${report.latestVersion} hook compatibility`, '--body-file', prBody]);
  if (created.code !== 0) throw new Error(`PR creation failed: ${created.output}`);
  return created.output.trim().split('\n').at(-1);
}

async function issueFor(report, prUrl, temporary, publicationError) {
  const title = `[compatibility] Codex CLI ${report.latestVersion} review`;
  const issues = await run('gh', ['issue', 'list', '-R', repository, '--state', 'all', '--limit', '500', '--json', 'title,url,number,body']);
  if (issues.code !== 0) throw new Error(`Cannot list issues: ${issues.output}`);
  const existing = JSON.parse(issues.output).find((issue) => issue.title === title);
  const marker = `<!-- compat-state:${alertState(report, publicationError)} -->`;
  const changed = !existing?.body?.includes(marker);
  const issueBody = join(temporary, 'issue-body.md');
  await writeFile(issueBody, body(report, prUrl, publicationError));
  const result = existing
    ? await run('gh', ['issue', 'edit', String(existing.number), '-R', repository, '--body-file', issueBody])
    : await run('gh', ['issue', 'create', '-R', repository, '--title', title, '--body-file', issueBody]);
  if (result.code !== 0) throw new Error(`Issue update failed: ${result.output}`);
  return { url: existing?.url ?? result.output.trim().split('\n').at(-1), changed };
}

async function notify(message) {
  if (!process.env.COMPAT_SLACK_WEBHOOK_URL) return;
  const url = new URL(process.env.COMPAT_SLACK_WEBHOOK_URL);
  if (url.protocol !== 'https:') throw new Error('Slack webhook must use HTTPS');
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Slack notification HTTP ${response.status}`);
}

async function main() {
  if (process.env.COMPAT_DRY_RUN === 'true') {
    process.stdout.write('Dry run: no issue, PR, or Slack writes.\n');
    return;
  }
  let report;
  try { report = JSON.parse(await readFile(join(root, 'compatibility-report.json'), 'utf8')); } catch { /* failure path */ }
  if (!report) {
    await notify(`🔴 Codex compatibility workflow failed before producing evidence. ${runUrl}`);
    return;
  }
  if (report.proposal?.status === 'pending-validation') {
    report.proposal = { status: 'rejected', reason: 'Secretless validation did not complete or its artifact was unavailable' };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'neatlogs-codex-publish-'));
  let alerted = false;
  try {
    let prUrl = null;
    let publicationError = null;
    try { prUrl = await publishPr(report, temporary); }
    catch (error) { publicationError = error instanceof Error ? error.message : String(error); }
    const issue = await issueFor(report, prUrl, temporary, publicationError);
    if (issue.changed) {
      const icon = report.classification === 'candidate-regression' ? '🔴'
        : ['baseline-verified', 'no-regression-in-tested-scope'].includes(report.classification) ? '✅' : '⚠️';
      const versionText = report.relation === 'same'
        ? `Codex CLI recorded version ${report.baselineVersion}`
        : `Codex CLI ${report.baselineVersion} → ${report.latestVersion}`;
      await notify(`${icon} ${versionText}. ${outcome(report)} ${prUrl ? `Review PR: ${prUrl}.` : report.classification === 'candidate-regression' ? 'No PR opened.' : ''} ${publicationError ? `PR publication blocked: ${publicationError.slice(0, 200)}.` : ''} Review issue: ${issue.url}. Evidence: ${runUrl}`);
      alerted = true;
    }
    if (publicationError) throw new Error(publicationError);
  } catch (error) {
    if (!alerted) await notify(`🔴 Codex compatibility workflow could not publish its result: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}. Evidence: ${runUrl}`);
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
