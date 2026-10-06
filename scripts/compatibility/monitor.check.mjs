import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRegression, compareVersions, validatePatchShape } from './monitor.mjs';

test('only newer npm releases require a compatibility comparison', () => {
  assert.equal(compareVersions('0.160.0', '0.160.0'), 'same');
  assert.equal(compareVersions('0.160.0', '0.161.0'), 'newer');
  assert.equal(compareVersions('0.160.0', '0.159.9'), 'older');
});

test('only passing baseline and failing latest live canaries identify a candidate regression', () => {
  assert.equal(classifyRegression({ status: 'pass' }, { status: 'fail' }), 'candidate-regression');
  assert.equal(classifyRegression({ status: 'blocked' }, { status: 'fail' }), 'blocked');
  assert.equal(classifyRegression({ status: 'pass' }, { status: 'blocked' }), 'blocked');
  assert.equal(classifyRegression({ status: 'pass' }, { status: 'pass' }), 'no-regression-in-tested-scope');
});

test('Gemini cannot expand the patch into workflow or credential files', () => {
  const good = [
    'diff --git a/src/codex-events.ts b/src/codex-events.ts',
    '--- a/src/codex-events.ts', '+++ b/src/codex-events.ts',
    '@@ -1,1 +1,1 @@', '-before', '+after',
    'diff --git a/test/hook-coverage.test.ts b/test/hook-coverage.test.ts',
    '--- a/test/hook-coverage.test.ts', '+++ b/test/hook-coverage.test.ts',
    '@@ -1,1 +1,1 @@', '-before', '+after',
  ].join('\n');
  assert.equal(validatePatchShape(good), true);
  assert.equal(validatePatchShape(good.replace('test/hook-coverage.test.ts', '.github/workflows/ci.yml')), false);
  assert.equal(validatePatchShape(good.replace('src/codex-events.ts', '../secrets.env')), false);
});
