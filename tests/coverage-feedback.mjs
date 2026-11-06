import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'coverage-feedback-target.js');
const mockFixture = path.join(projectDir, 'examples', 'coverage-feedback-mock-target.js');
const callbackFixture = path.join(projectDir, 'examples', 'mcdc-callbacks-advanced.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-coverage-test-'));
const outputFromFile = path.join(tempDir, 'from-file.json');
const outputWithJest = path.join(tempDir, 'with-jest.json');
const coverageFile = path.join(tempDir, 'coverage-final.json');
const fakeJestScript = path.join(projectDir, 'tests', 'fixtures', 'fake-jest-runner.cjs');
const fakeJestCommand = path.join(tempDir, 'fake-jest');

function run(args, extra = {}, sourceFile = fixture, functionName = 'coverageTarget') {
  const result = spawnSync(process.execPath, [cli, sourceFile, '--function', functionName, '--mcdc', ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, ...extra },
  });
  assert.equal(result.status, 0, `CLI failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  const sourceUrl = pathToFileURL(fixture).href;
  const sourceLine = 2;
  const coverageEntry = {
    path: fixture,
    statementMap: {
      0: { start: { line: 3, column: 4 }, end: { line: 3, column: 25 } },
      1: { start: { line: 5, column: 2 }, end: { line: 5, column: 22 } },
    },
    fnMap: { 0: { name: 'coverageTarget', decl: { start: { line: 1, column: 7 }, end: { line: 1, column: 29 } }, loc: { start: { line: 1, column: 40 }, end: { line: 6, column: 1 } }, line: 1 } },
    branchMap: {
      0: {
        type: 'if',
        loc: { start: { line: sourceLine, column: 2 }, end: { line: sourceLine, column: 43 } },
        locations: [
          { start: { line: 2, column: 44 }, end: { line: 4, column: 3 } },
          { start: { line: 5, column: 2 }, end: { line: 5, column: 22 } },
        ],
      },
    },
    s: { 0: 1, 1: 1 },
    f: { 0: 2 },
    b: { 0: [1, 1] },
    l: { 1: 1, 2: 2, 3: 1, 4: 1, 5: 1 },
  };
  fs.writeFileSync(coverageFile, JSON.stringify({ [fixture]: coverageEntry }, null, 2));

  // Existing coverage can be loaded without requiring Jest in the generator environment.
  run(['--coverage-from', coverageFile, '--out', outputFromFile]);
  const fromFile = JSON.parse(fs.readFileSync(outputFromFile, 'utf8'));
  assert.equal(fromFile.coverageFeedback.status, 'coverage-loaded');
  assert.equal(fromFile.coverageFeedback.iterative.enabled, false);
  assert.equal(fromFile.coverageFeedback.iterative.stopReason, 'external-coverage-is-read-only');
  assert.equal(fromFile.coverageFeedback.totals.branches.covered, 2);
  assert.equal(fromFile.coverageFeedback.totals.branches.total, 2);
  assert.equal(fromFile.coverageFeedback.branchCoverage.allFileBranchesCovered, true);
  assert.equal(fromFile.coverageFeedback.branchCoverage.staticTargetsCovered, 1);
  assert.equal(fromFile.coverageFeedback.staticBranchTargets.length, 1);
  assert.equal(fromFile.coverageFeedback.staticBranchTargets[0].coverageStatus, 'covered');

  // A minimal Jest-compatible runner executes the generated adapter hooks and
  // target scenarios, then writes a synthetic Istanbul report. This tests the
  // integration without requiring a network-installed Jest in this workspace.
  fs.writeFileSync(fakeJestCommand, `#!/bin/sh\nexec "${process.execPath}" "${fakeJestScript}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(fakeJestCommand, 0o755);

  run(['--coverage-feedback', '--coverage-provider', 'babel', '--jest-bin', fakeJestCommand, '--jest-setup', path.join(projectDir, 'tests', 'fixtures', 'coverage-feedback-setup.mjs'), '--out', outputWithJest]);
  const withJest = JSON.parse(fs.readFileSync(outputWithJest, 'utf8'));
  assert.equal(withJest.coverageFeedback.status, 'passed');
  assert.equal(withJest.coverageFeedback.provider, 'babel');
  assert.ok(withJest.coverageFeedback.execution.generatedCases > 0);
  assert.equal(withJest.coverageFeedback.execution.testResults.numFailedTests, 0);
  assert.ok(withJest.coverageFeedback.execution.mcdcPairs.length > 0);
  assert.ok(withJest.coverageFeedback.execution.mcdcPairs.every(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)));
  assert.ok(withJest.coverageFeedback.mcdc.runtimeInstrumentation.decisionsInstrumented > 0);
  assert.equal(withJest.coverageFeedback.mcdc.runtimeInstrumentation.instrumentedSourceCleanup, 'removed-after-run');
  assert.equal(fs.existsSync(path.join(path.dirname(fixture), withJest.coverageFeedback.mcdc.runtimeInstrumentation.instrumentedSource)), false);
  assert.ok(withJest.coverageFeedback.execution.mcdcRuntimeTraces.length > 0);
  assert.equal(withJest.coverageFeedback.mcdc.verificationScope.runtimeVerifiedPairs, withJest.coverageFeedback.execution.mcdcPairs.length);
  assert.equal(withJest.coverageFeedback.mcdc.inputPairVerification, 'all-pairs-runtime-verified-with-short-circuit-inference');
  assert.equal(withJest.coverageFeedback.execution.mcdcPairsInputVerified, withJest.coverageFeedback.execution.mcdcPairs.length);
  assert.equal(withJest.coverageFeedback.execution.mcdcPairsRuntimeVerified, withJest.coverageFeedback.execution.mcdcPairs.length);
  assert.ok(withJest.coverageFeedback.execution.mcdcPairsFullyRuntimeInstrumented < withJest.coverageFeedback.execution.mcdcPairsRuntimeVerified);
  assert.equal(withJest.coverageFeedback.execution.mcdcPairsWithBothScenariosPassed, withJest.coverageFeedback.execution.mcdcPairs.length);
  assert.ok(withJest.coverageFeedback.execution.mcdcPairs.every(pair => pair.bothScenariosPassed === true));
  assert.ok(withJest.coverageFeedback.execution.mcdcRuntimeChecks.every(check => check.trace?.conditions?.[check.targetConditionId]?.evaluated === true));
  assert.ok(withJest.coverageFeedback.execution.mcdcRuntimeChecks.some(check => check.status === 'runtime-verified-with-short-circuit-inference'));
  assert.ok(fs.existsSync(withJest.coverageFeedback.coverageFile));
  assert.equal(withJest.coverageFeedback.branchCoverage.allFileBranchesCovered, true);
  assert.equal(withJest.coverageFeedback.execution.testResults.setupHookCalls, withJest.coverageFeedback.execution.generatedCases);
  assert.equal(withJest.coverageFeedback.execution.testResults.jestResetAllMocksCalls, withJest.coverageFeedback.execution.generatedCases, 'Jest mocks must be reset before every test.each row');

  // Project setup can hydrate scenario-specific mock templates before each call.
  const mockOutput = path.join(tempDir, 'with-mocks.json');
  run([
    '--coverage-feedback', '--jest-bin', fakeJestCommand,
    '--jest-setup', path.join(projectDir, 'tests', 'fixtures', 'coverage-feedback-mock-setup.mjs'),
    '--out', mockOutput,
  ], {}, mockFixture, 'coverageMockTarget');
  const withMocks = JSON.parse(fs.readFileSync(mockOutput, 'utf8'));
  assert.equal(withMocks.coverageFeedback.status, 'passed');
  assert.ok(withMocks.functions[0].scenarios.every(scenario => Array.isArray(scenario.mocks) && scenario.mocks.length === 1));
  assert.equal(withMocks.coverageFeedback.execution.testResults.numFailedTests, 0);
  assert.equal(withMocks.coverageFeedback.execution.testResults.setupHookCalls, withMocks.coverageFeedback.execution.generatedCases);
  assert.equal(withMocks.coverageFeedback.execution.testResults.jestResetAllMocksCalls, withMocks.coverageFeedback.execution.generatedCases, 'mock-backed test.each rows must each begin with resetAllMocks');

  // Callback MC/DC input scopes resolve both the function argument and callback item/index.
  const callbackOutput = path.join(tempDir, 'with-callback-mcdc.json');
  run([
    '--coverage-feedback', '--jest-bin', fakeJestCommand,
    '--out', callbackOutput,
  ], {}, callbackFixture, 'callbackLocalAliases');
  const withCallbacks = JSON.parse(fs.readFileSync(callbackOutput, 'utf8'));
  assert.equal(withCallbacks.coverageFeedback.status, 'passed');
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcPairs.length > 0);
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcPairs.every(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)));
  assert.ok(withCallbacks.coverageFeedback.mcdc.runtimeInstrumentation.conditionsInstrumented > 0);
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcRuntimeChecks.length > 0);
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcRuntimeTraces.some(trace => trace.callbackContext?.method === 'some'));
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcRuntimeChecks.every(check => ['runtime-instrumented-verified', 'runtime-verified-with-short-circuit-inference'].includes(check.status)));
  assert.ok(withCallbacks.coverageFeedback.execution.mcdcRuntimeChecks.every(check => check.trace?.conditions?.[check.targetConditionId]?.evaluated === true));
  assert.equal(withCallbacks.coverageFeedback.mcdc.verificationScope.runtimeVerifiedPairs, withCallbacks.coverageFeedback.execution.mcdcPairs.length);


  // Runtime callback tracing must observe the selected index, not just
  // recompute the predicate against the representative array element.
  const indexOutput = path.join(tempDir, 'with-index-runtime-mcdc.json');
  run([
    '--coverage-feedback', '--jest-bin', fakeJestCommand,
    '--out', indexOutput,
  ], {}, callbackFixture, 'indexSensitive');
  const withIndex = JSON.parse(fs.readFileSync(indexOutput, 'utf8'));
  assert.equal(withIndex.coverageFeedback.status, 'passed');
  assert.ok(withIndex.coverageFeedback.execution.mcdcPairs.length > 0);
  assert.ok(withIndex.coverageFeedback.execution.mcdcPairs.every(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)));
  assert.ok(withIndex.coverageFeedback.execution.mcdcRuntimeTraces.some(check => check.callbackContext?.iterationIndex === 1));

  // Nested callback paths include a numeric element segment in the static
  // path (input.groups.0.passengers) but are observed through an array Proxy
  // path (input.groups[0].passengers).
  const nestedOutput = path.join(tempDir, 'with-nested-runtime-mcdc.json');
  run([
    '--coverage-feedback', '--jest-bin', fakeJestCommand,
    '--out', nestedOutput,
  ], {}, path.join(projectDir, 'examples', 'mcdc-callbacks.js'), 'nestedPredicate');
  const withNested = JSON.parse(fs.readFileSync(nestedOutput, 'utf8'));
  assert.equal(withNested.coverageFeedback.status, 'passed');
  assert.ok(withNested.coverageFeedback.execution.mcdcRuntimeTraces.some(check => check.callbackContext?.method === 'every'));

  const missingJestOutput = path.join(tempDir, 'missing-jest.json');
  const missingJest = spawnSync(process.execPath, [
    cli, fixture, '--function', 'coverageTarget', '--mcdc', '--coverage-feedback',
    '--jest-bin', path.join(tempDir, 'jest-does-not-exist'), '--out', missingJestOutput,
  ], { cwd: projectDir, encoding: 'utf8' });
  assert.notEqual(missingJest.status, 0);
  const missingJestReport = JSON.parse(fs.readFileSync(missingJestOutput, 'utf8'));
  assert.equal(missingJestReport.coverageFeedback.status, 'jest-not-found');

  // Known incompatible consumer Jest releases fail before the harness is launched.
  const jest26Root = path.join(tempDir, 'old-project', 'node_modules', 'jest');
  const jest26Bin = path.join(jest26Root, 'bin', 'jest.js');
  fs.mkdirSync(path.dirname(jest26Bin), { recursive: true });
  fs.writeFileSync(path.join(jest26Root, 'package.json'), JSON.stringify({ name: 'jest', version: '26.6.0' }));
  fs.writeFileSync(jest26Bin, '');
  const oldJestOutput = path.join(tempDir, 'old-jest.json');
  const oldJest = spawnSync(process.execPath, [
    cli, fixture, '--function', 'coverageTarget', '--mcdc', '--coverage-feedback',
    '--jest-bin', jest26Bin, '--out', oldJestOutput,
  ], { cwd: projectDir, encoding: 'utf8' });
  assert.notEqual(oldJest.status, 0, `incompatible Jest should be reported in the JSON result, not crash the CLI: ${oldJest.stderr}`);
  const oldJestReport = JSON.parse(fs.readFileSync(oldJestOutput, 'utf8'));
  assert.equal(oldJestReport.coverageFeedback.status, 'jest-version-unsupported');
  assert.equal(oldJestReport.coverageFeedback.actualJestVersion, '26.6.0');

  console.log(`Coverage feedback tests passed: ${withJest.coverageFeedback.execution.generatedCases} generated cases, ${withJest.coverageFeedback.execution.mcdcPairs.length} MC/DC pairs; synthetic Istanbul mapping verified.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
