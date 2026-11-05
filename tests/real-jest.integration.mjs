import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const configuredJest = process.env.JEST_BIN;
function findJest() {
  if (configuredJest) {
    const explicit = path.resolve(configuredJest);
    assert.ok(fs.existsSync(explicit), `JEST_BIN does not exist: ${explicit}`);
    return explicit;
  }
  const roots = [process.cwd(), projectDir];
  for (const root of roots) {
    let current = path.resolve(root);
    while (true) {
      for (const relative of ['node_modules/jest/bin/jest.js', 'node_modules/jest-cli/bin/jest.js']) {
        const candidate = path.join(current, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

const jestBin = findJest();
if (!jestBin) {
  console.log('Real Jest integration test skipped: Jest is not installed here. Set JEST_BIN to run it against your project Jest.');
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-real-jest-'));
try {
  const sourceFile = path.join(tempDir, 'target.mjs');
  const configFile = path.join(tempDir, 'jest.config.cjs');
  const outputFile = path.join(tempDir, 'real-jest-coverage.json');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(sourceFile, `export function realJestTarget(input) {\n  if (input.enabled && input.score >= 10) return 'active';\n  return 'inactive';\n}\n`);
  fs.writeFileSync(configFile, `module.exports = {\n  rootDir: __dirname,\n  transform: {},\n  testEnvironment: 'node',\n  testRegex: '.*\\\\.test\\\\.cjs$',\n  collectCoverageFrom: ['target.mjs'],\n};\n`);

  const result = spawnSync(process.execPath, [
    cli, sourceFile,
    '--function', 'realJestTarget',
    '--mcdc',
    '--coverage-feedback',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', configFile,
    '--out', outputFile,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });

  assert.equal(result.status, 0, `Real Jest integration failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(report.coverageFeedback.status, 'passed');
  assert.ok(report.coverageFeedback.execution.testResults.numPassedTests > 0);
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.enabled, 'Expected source-level runtime MC/DC instrumentation.');
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.coveragePathRemapped, 'Expected instrumented coverage to be remapped to the original source path.');
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.decisionsInstrumented > 0);
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.conditionsInstrumented > 0);
  assert.ok(report.coverageFeedback.execution.mcdcPairs.length > 0);
  assert.ok(report.coverageFeedback.execution.mcdcPairs.every(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)));
  assert.ok(report.coverageFeedback.execution.mcdcRuntimeChecks.every(check => check.trace?.conditions?.[check.targetConditionId]?.evaluated === true));
  assert.equal(report.coverageFeedback.execution.testResults.numFailedTests, 0);
  assert.ok(report.coverageFeedback.totals.branches.total > 0);
  assert.ok(report.coverageFeedback.staticBranchTargets.length > 0);
  const mappedIfTargets = report.coverageFeedback.staticBranchTargets.filter(target => target.kind === 'if' && target.coverageBranchId);
  assert.ok(mappedIfTargets.length > 0, 'Expected the real Jest Istanbul branch map to match the analyzed if statement.');
  assert.ok(mappedIfTargets.some(target => target.coverageStatus === 'covered' || target.coverageStatus === 'partially-covered'));
  assert.ok(fs.existsSync(report.coverageFeedback.coverageFile));

  // Exercise the per-scenario attribution and minimal-suite path with the same
  // real Jest installation. This is skipped in environments without Jest.
  const minimalOutput = path.join(tempDir, 'real-jest-minimal-suite.json');
  const minimalDataOutput = path.join(tempDir, 'real-jest-minimal-data.json');
  const minimalRun = spawnSync(process.execPath, [
    cli, sourceFile,
    '--function', 'realJestTarget',
    '--minimal-suite',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', configFile,
    '--minimal-suite-out', minimalDataOutput,
    '--out', minimalOutput,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });
  assert.equal(minimalRun.status, 0, `Real Jest minimal-suite integration failed:\n${minimalRun.stdout}\n${minimalRun.stderr}`);
  const minimalReport = JSON.parse(fs.readFileSync(minimalOutput, 'utf8'));
  const minimal = minimalReport.coverageFeedback.minimalTestSet;
  const scenarioCoverage = minimalReport.coverageFeedback.execution.scenarioCoverage;
  assert.ok(scenarioCoverage.casesWithBranchAttribution > 0);
  assert.equal(minimal.status, 'complete');
  assert.ok(minimal.selectedCases > 0);
  assert.ok(minimal.selectedCases <= minimal.candidateCases);
  assert.ok(fs.existsSync(minimalDataOutput));
  const minimalData = JSON.parse(fs.readFileSync(minimalDataOutput, 'utf8'));
  assert.deepEqual(minimalData.minimalTestSet.selectedCaseIds, minimal.selectedCaseIds);
  for (const pair of minimalReport.coverageFeedback.execution.mcdcPairs.filter(item => item.status.startsWith('runtime-mcdc-verified'))) {
    assert.ok(minimal.selectedCaseIds.includes(pair.conditionFalseCaseId));
    assert.ok(minimal.selectedCaseIds.includes(pair.conditionTrueCaseId));
  }

  console.log(`Real Jest integration passed: ${report.coverageFeedback.execution.testResults.numPassedTests} generated tests; ${report.coverageFeedback.totals.branches.covered}/${report.coverageFeedback.totals.branches.total} Istanbul branch counters covered; minimal suite ${minimal.selectedCases}/${minimal.candidateCases} cases.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
