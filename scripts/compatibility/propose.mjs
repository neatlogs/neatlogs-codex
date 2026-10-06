import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gemini, root, validatePatchShape } from './monitor.mjs';

const reportPath = join(root, 'compatibility-report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (report.classification !== 'candidate-regression') {
  report.gemini = {
    status: 'skipped',
    reason: report.relation === 'same'
      ? 'No newer npm release to analyze'
      : 'No baseline-pass/latest-fail hook regression was established',
  };
  report.proposal = { status: 'not-proposed', reason: 'No confirmed candidate regression' };
} else {
  try {
    report.gemini = await gemini(
      report,
      process.env.COMPAT_GEMINI_API_KEY,
      process.env.COMPAT_GEMINI_MODEL || 'gemini-2.5-flash',
    );
  } catch (error) {
    report.gemini = { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
  report.proposal = report.gemini?.decision === 'propose_fix' && validatePatchShape(report.gemini.patch)
    ? { status: 'pending-validation', reason: 'Gemini patch awaits secretless red-green validation' }
    : { status: 'not-proposed', reason: report.gemini?.reason ?? 'Gemini produced no bounded patch' };
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Gemini: ${report.gemini.status}; proposal: ${report.proposal.status}\n`);
