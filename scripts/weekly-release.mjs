#!/usr/bin/env node
/** Decide whether the weekly job should publish or bump a patch release. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const configurations = {
  neatlogs: {
    releasePaths: ['src', 'package.json', 'package-lock.json', 'tsup.config.ts', 'README.md', 'LICENSE'],
    syncCommand: ['node', 'scripts/sync-version.mjs'],
    lockCommand: ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    versionFiles: ['package.json', 'package-lock.json', 'src/version.ts'],
  },
  '@neatlogs/wizard': {
    releasePaths: ['src', 'bin.ts', 'assets', 'package.json', 'pnpm-lock.yaml', 'tsdown.config.ts', 'README.md', 'CHANGELOG.md'],
    lockCommand: ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'],
    versionFiles: ['package.json', 'pnpm-lock.yaml'],
  },
  '@neatlogs/claude-code': {
    releasePaths: ['src', 'hooks', '.claude-plugin', 'package.json', 'package-lock.json', 'tsup.config.ts', 'README.md'],
    manifests: ['.claude-plugin/plugin.json'],
    lockCommand: ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    versionFiles: ['package.json', 'package-lock.json', '.claude-plugin/plugin.json'],
  },
  '@neatlogs/codex': {
    releasePaths: ['src', 'hooks', 'assets', '.codex-plugin', 'package.json', 'package-lock.json', 'tsup.config.ts', 'README.md', 'PLAN.md'],
    manifests: ['.codex-plugin/plugin.json'],
    lockCommand: ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    versionFiles: ['package.json', 'package-lock.json', '.codex-plugin/plugin.json', 'README.md'],
  },
};
const configuration = configurations[packageJson.name];
if (!configuration) throw new Error(`unsupported release package: ${packageJson.name}`);
const { releasePaths } = configuration;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function parseVersion(value, label) {
  if (!stableVersion.test(value)) throw new Error(`${label} must be a stable major.minor.patch version: ${value}`);
  return value.split('.').map(Number);
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

async function publishedRelease() {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageJson.name)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const metadata = await response.json();
  const version = metadata['dist-tags']?.latest;
  parseVersion(version, 'npm latest');
  const publishedAt = metadata.time?.[version];
  if (!metadata.versions?.[version] || !publishedAt) throw new Error('npm latest has no published metadata');
  return { version, publishedAt, versions: metadata.versions };
}

function baseline(version, publishedAt) {
  const tag = `v${version}`;
  const tagged = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
    cwd: root, encoding: 'utf8',
  });
  if (tagged.status === 0) {
    const commit = tagged.stdout.trim();
    command('git', ['merge-base', '--is-ancestor', commit, 'HEAD']);
    return { commit, description: tag, verified: true };
  }
  // Existing npm releases predate exact Git tags. This is a one-time bootstrap
  // estimate; subsequent runs use the tags created by this workflow.
  const commit = git('rev-list', '--first-parent', '-1', `--before=${publishedAt}`, 'HEAD');
  if (!commit) throw new Error(`No mainline commit predates npm ${version}; create a verified baseline tag`);
  return { commit, description: `mainline before ${publishedAt}`, verified: false };
}

async function plan() {
  const current = packageJson.version;
  const currentParts = parseVersion(current, 'package.json version');
  const published = await publishedRelease();
  const comparison = compare(currentParts, parseVersion(published.version, 'npm latest'));
  if (comparison < 0) throw new Error(`source ${current} is behind npm ${published.version}`);
  if (comparison > 0) {
    if (published.versions[current]) throw new Error(`${current} is already published under another npm dist-tag`);
    return { action: 'publish', version: current, published: published.version, bump: false };
  }

  const source = baseline(current, published.publishedAt);
  const diff = spawnSync('git', ['diff', '--quiet', source.commit, 'HEAD', '--', ...releasePaths], {
    cwd: root, encoding: 'utf8',
  });
  if (![0, 1].includes(diff.status)) throw new Error(diff.stderr || 'git diff failed');
  if (diff.status === 0) {
    return { action: 'skip', version: current, published: published.version, baseline: source.description };
  }
  const next = `${currentParts[0]}.${currentParts[1]}.${currentParts[2] + 1}`;
  if (published.versions[next]) throw new Error(`${next} already exists on npm`);
  return {
    action: 'publish', version: next, published: published.version,
    bump: true, baseline: source.description, baseline_verified: source.verified,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some((arg) => arg !== '--apply')) {
    throw new Error('usage: node scripts/weekly-release.mjs [--apply]');
  }
  const result = await plan();
  if (apply && result.action === 'publish') {
    if (result.bump) command('npm', ['version', result.version, '--no-git-tag-version', '--ignore-scripts']);
    if (configuration.lockCommand) command(configuration.lockCommand[0], configuration.lockCommand.slice(1));
    if (configuration.syncCommand) command(configuration.syncCommand[0], configuration.syncCommand.slice(1));
    for (const manifest of configuration.manifests ?? []) {
      const path = join(root, manifest);
      const original = readFileSync(path, 'utf8');
      const current = JSON.parse(original).version;
      if (current !== result.version) {
        const updated = original.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, (_, start, end) => `${start}${result.version}${end}`);
        if (updated === original) throw new Error(`could not update ${manifest} version`);
        writeFileSync(path, updated);
      }
    }
    if (packageJson.name === '@neatlogs/codex') {
      const path = join(root, 'README.md');
      const original = readFileSync(path, 'utf8');
      const updated = original.replace(/Current release: `[^`]+`/, `Current release: \`${result.version}\``);
      if (!original.includes('Current release:')) throw new Error('could not find README.md release version');
      if (updated !== original) writeFileSync(path, updated);
    }
    const diff = spawnSync('git', ['diff', '--quiet', '--', ...configuration.versionFiles], {
      cwd: root, encoding: 'utf8',
    });
    if (![0, 1].includes(diff.status)) throw new Error(diff.stderr || 'git diff failed');
    result.commit = diff.status === 1;
  }
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(`weekly release failed: ${error.message}`);
  process.exitCode = 1;
});
