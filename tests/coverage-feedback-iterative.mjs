import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'coverage-feedback-iterative-target.js');
const fakeJestScript = path.join(projectDir, 'tests', 'fixtures', 'fake-jest-runner.cjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-iterative-'));
const fakeJestCommand = fakeJestScript;
const output = path.join(tempDir, 'iterative.json');

try {

  const run = spawnSync(process.execPath, [
    cli, fixture,
    '--function', 'iterativeCoverageTarget',
    '--max-scenarios', '1',
    '--coverage-feedback',
    '--coverage-iterations', '3',
    '--coverage-goal', '100',
    '--jest-bin', fakeJestCommand,
    '--out', output,
  ], { cwd: projectDir, encoding: 'utf8' });

  assert.equal(run.status, 0, `Iterative coverage CLI failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const iterative = report.coverageFeedback.iterative;

  assert.equal(report.coverageFeedback.status, 'passed');
  assert.equal(iterative.enabled, true);
  assert.equal(iterative.iterations.length, 2, 'Expected one initial pass and one expansion pass');
  assert.equal(iterative.stopReason, 'coverage-goal-reached');
  assert.equal(iterative.goalReached, true);
  assert.equal(iterative.iterations[0].branchCoverage.pct, 50);
  assert.equal(iterative.iterations[1].branchCoverage.pct, 100);
  assert.equal(iterative.iterations[1].addedScenarioCount, 1);
  assert.ok(report.functions[0].scenarios.some(scenario => scenario.arguments[0]?.region === 'DE'));

  console.log('Iterative coverage tests passed: uncovered outcome identified, one targeted candidate added, cumulative Jest rerun reached 100% branch coverage.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
