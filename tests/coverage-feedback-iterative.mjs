import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'coverage-feedback-iterative-target.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-iterative-'));
const output = path.join(tempDir, 'iterative.json');

try {

  const run = spawnSync(process.execPath, [
    cli, fixture,
    '--function', 'iterativeCoverageTarget',
    '--max-scenarios', '1',
    '--coverage-feedback',
    '--coverage-iterations', '3',
    '--coverage-goal', '100',
    '--out', output,
  ], { cwd: projectDir, encoding: 'utf8' });

  assert.equal(run.status, 0, `Iterative coverage CLI failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const iterative = report.coverageFeedback.iterative;

  assert.equal(report.coverageFeedback.status, 'passed');
  assert.equal(iterative.enabled, true);
  // The real Jest/Istanbul run is authoritative. The simple fixture is already
  // fully represented by the initially generated scenarios, so this integration
  // case validates the no-expansion path; targeted expansion itself is covered
  // with deterministic injected feedback in iterative-coverage-modules.mjs.
  assert.equal(iterative.iterations.length, 1, 'A fully covered fixture should stop after the initial real Jest pass');
  assert.ok(Number.isFinite(iterative.iterations[0].branchCoverage.pct));
  assert.ok(['coverage-goal-reached', 'all-mapped-static-targets-covered'].includes(iterative.stopReason));
  assert.equal(iterative.iterations[0].iteration, 1);
  assert.ok(report.coverageFeedback.execution.testResults.numPassedTests > 0);
  assert.equal(report.coverageFeedback.jest.exitCode, 0);
  assert.ok(fs.existsSync(report.coverageFeedback.coverageFile));

  console.log('Iterative coverage integration passed: real Jest/Istanbul coverage was collected and the completed initial suite stopped without a synthetic expansion.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
