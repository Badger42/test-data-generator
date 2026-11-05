import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'minimal-suite-target.js');
const fakeJestScript = path.join(projectDir, 'tests', 'fixtures', 'fake-jest-runner.cjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-minimal-suite-'));
const fakeJestCommand = path.join(tempDir, 'fake-jest');
const output = path.join(tempDir, 'coverage-report.json');
const minimalOutput = path.join(tempDir, 'minimal-suite.json');

try {
  fs.writeFileSync(fakeJestCommand, `#!/bin/sh\nexec "${process.execPath}" "${fakeJestScript}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(fakeJestCommand, 0o755);

  const run = spawnSync(process.execPath, [
    cli, fixture,
    '--function', 'minimalSuiteTarget',
    '--minimal-suite',
    '--coverage-provider', 'v8',
    '--coverage-iterations', '1',
    '--jest-bin', fakeJestCommand,
    '--minimal-suite-out', minimalOutput,
    '--out', output,
  ], { cwd: projectDir, encoding: 'utf8' });

  assert.equal(run.status, 0, `Minimal-suite CLI failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const separate = JSON.parse(fs.readFileSync(minimalOutput, 'utf8'));
  const feedback = report.coverageFeedback;
  const attribution = feedback.execution.scenarioCoverage;
  const minimal = feedback.minimalTestSet;

  assert.equal(feedback.status, 'passed');
  assert.ok(attribution, 'Expected per-scenario coverage attribution');
  assert.equal(attribution.totalCases, feedback.execution.generatedCases);
  assert.equal(attribution.passedCases, attribution.totalCases);
  assert.ok(attribution.casesWithBranchAttribution > 0);
  assert.ok(attribution.cases.every(item => Array.isArray(item.coveredBranchOutcomes)));
  assert.ok(attribution.cases.some(item => item.coveredBranchOutcomes.some(outcome => outcome.outcome === true)));
  assert.ok(attribution.cases.some(item => item.coveredBranchOutcomes.some(outcome => outcome.outcome === false)));

  assert.equal(minimal.status, 'complete');
  assert.equal(minimal.exactMinimumProven, true);
  assert.equal(minimal.algorithm, 'branch-and-bound-exact-set-cover');
  assert.ok(minimal.selectedCases > 0);
  assert.ok(minimal.selectedCases < minimal.candidateCases, 'Expected at least one redundant scenario to be removed');
  assert.equal(minimal.obligations, minimal.coveredObligations);
  assert.deepEqual(minimal.missingObligations, []);
  assert.ok(minimal.branchObligations >= 4);
  assert.ok(minimal.mcdcPairsPreserved >= 2);
  assert.equal(minimal.scenarios.length, minimal.selectedCases);
  assert.deepEqual(separate.minimalTestSet.selectedCaseIds, minimal.selectedCaseIds);
  assert.ok(minimal.scenarios.every(item => item.arguments && item.testName));

  for (const pair of feedback.execution.mcdcPairs.filter(item => item.status.startsWith('runtime-mcdc-verified'))) {
    for (const side of ['conditionFalse', 'conditionTrue']) {
      assert.ok(minimal.selectedCaseIds.includes(side === 'conditionFalse' ? pair.conditionFalseCaseId : pair.conditionTrueCaseId),
        `Minimal suite must retain ${side} side of ${pair.pairId}`);
    }
  }

  // Switch clause dispatch has no source-level runtime decision hook yet. The
  // minimizer must preserve one candidate for each switch target outcome and
  // label those obligations as target-reference fallbacks, not runtime proof.
  const switchFixture = path.join(projectDir, 'examples', 'minimal-suite-switch-target.js');
  const switchOutput = path.join(tempDir, 'switch-report.json');
  const switchRun = spawnSync(process.execPath, [
    cli, switchFixture,
    '--function', 'minimalSwitchTarget',
    '--minimal-suite',
    '--coverage-iterations', '1',
    '--jest-bin', fakeJestCommand,
    '--out', switchOutput,
  ], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(switchRun.status, 0, `Switch fallback CLI failed:\n${switchRun.stdout}\n${switchRun.stderr}`);
  const switchReport = JSON.parse(fs.readFileSync(switchOutput, 'utf8'));
  const switchMinimal = switchReport.coverageFeedback.minimalTestSet;
  assert.equal(switchMinimal.status, 'complete-with-conservative-fallbacks');
  assert.ok(switchMinimal.conservativeFallbacks.length >= 3);
  assert.ok(switchMinimal.conservativeFallbacks.every(item => item.evidence === 'switch-target-reference'));
  assert.ok(switchMinimal.conservativeFallbacks.every(item => item.selectedCaseIds.length >= 1));
  assert.ok(switchMinimal.exactMinimumProven);

  // Aggregate coverage loaded from a file cannot identify which case opened a
  // branch, so minimal-suite mode must report unavailable rather than guessing.
  const externalCoverage = path.join(tempDir, 'external-coverage.json');
  fs.writeFileSync(externalCoverage, JSON.stringify({
    [fixture]: {
      path: fixture, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {}, l: {},
    },
  }));
  const externalOutput = path.join(tempDir, 'external-coverage-report.json');
  const externalRun = spawnSync(process.execPath, [
    cli, fixture,
    '--function', 'minimalSuiteTarget',
    '--minimal-suite',
    '--coverage-from', externalCoverage,
    '--out', externalOutput,
  ], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(externalRun.status, 0, `External coverage CLI failed:\n${externalRun.stdout}\n${externalRun.stderr}`);
  const externalReport = JSON.parse(fs.readFileSync(externalOutput, 'utf8'));
  assert.equal(externalReport.coverageFeedback.minimalTestSet.status, 'unavailable');

  console.log(`Per-scenario attribution/minimal-suite tests passed: ${minimal.selectedCases}/${minimal.candidateCases} cases selected; ${minimal.branchObligations} runtime branch obligations; ${minimal.mcdcPairsPreserved} verified MC/DC pairs; switch fallback retained; external aggregate correctly unavailable.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
