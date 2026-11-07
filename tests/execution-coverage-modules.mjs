import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createJestRunner } from '../src/execution/jest-runner.mjs';
import { collectCoverageExecutionCases } from '../src/execution/coverage-case-collector.mjs';
import { buildJestFeedbackTest } from '../src/execution/jest-test-harness.mjs';
import { readJestTestResults } from '../src/execution/test-result-reader.mjs';
import { readRuntimeTraceFile } from '../src/execution/runtime-trace-reader.mjs';
import { readIstanbulCoverage, summarizeCounterMap } from '../src/coverage/istanbul-reader.mjs';
import { createSourceMapNormalizer } from '../src/coverage/source-map-normalizer.mjs';
import { createBranchMapper } from '../src/coverage/branch-mapper.mjs';
import { createCoverageFeedbackBuilder } from '../src/coverage/coverage-feedback-builder.mjs';
import { buildScenarioCoverageAttribution } from '../src/coverage/scenario-attributor.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-execution-coverage-'));
try {
  const packageRoot = path.join(temp, 'project');
  const sourceDir = path.join(packageRoot, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
  const sourceFile = path.join(sourceDir, 'target.js');
  fs.writeFileSync(sourceFile, 'export function target(value) { return value; }');
  const jestRunner = createJestRunner({ fs, path, process, spawnSync: () => ({ status: 0 }) });
  const pinnedRunner = jestRunner.findJestRunner();
  assert.equal(pinnedRunner.command, process.execPath);
  assert.equal(pinnedRunner.shell, false);
  assert.equal(pinnedRunner.version, '30.5.2');
  assert.match(pinnedRunner.prefixArgs[0], /node_modules[\\/]jest[\\/]bin[\\/]jest\.js$/);
  assert.equal(jestRunner.resolveJestWorkingDirectory(sourceFile, null), packageRoot);

  // A consumer project's own Jest must not influence the generator runtime.
  const consumerJest = path.join(packageRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  fs.mkdirSync(path.dirname(consumerJest), { recursive: true });
  fs.writeFileSync(consumerJest, '');
  assert.deepEqual(jestRunner.findJestRunner(), pinnedRunner,
    'Jest resolution must stay anchored to the generator even when the target project has its own installation');

  assert.equal(jestRunner.run('cmd', [], {}).status, 0);

  // Resolve the real package version through a symlink and a Windows .cmd shim.
  const packagedJest = path.join(temp, 'version-project', 'node_modules', 'jest');
  const packagedJestScript = path.join(packagedJest, 'bin', 'jest.js');
  const packagedBin = path.join(temp, 'version-project', 'node_modules', '.bin');
  fs.mkdirSync(path.dirname(packagedJestScript), { recursive: true });
  fs.mkdirSync(packagedBin, { recursive: true });
  fs.writeFileSync(path.join(packagedJest, 'package.json'), JSON.stringify({ name: 'jest', version: '30.5.2' }));
  fs.writeFileSync(packagedJestScript, '');
  if (process.platform !== 'win32') {
    const symlinkPath = path.join(packagedBin, 'jest');
    fs.symlinkSync(packagedJestScript, symlinkPath);
    const symlinkRunner = jestRunner.findJestRunner(symlinkPath, sourceFile, null);
    assert.equal(symlinkRunner.version, '30.5.2', 'symlink launcher must resolve its Jest package version');
  }

  const commandShim = path.join(packagedBin, 'jest.cmd');
  fs.writeFileSync(commandShim, '@"%~dp0%/../jest/bin/jest.js" %*\r\n');
  const windowsRunner = createJestRunner({
    fs, path,
    process: { cwd: () => temp, platform: 'win32', execPath: process.execPath },
    spawnSync: () => ({ status: 0 }),
  }).findJestRunner(commandShim, sourceFile, null);
  assert.equal(windowsRunner.version, '30.5.2', 'Windows .cmd wrapper must resolve its Jest package version');
  assert.equal(windowsRunner.command, process.execPath, 'resolved Windows shims should be executed as Node scripts');
  assert.deepEqual(windowsRunner.prefixArgs, [packagedJestScript]);
  assert.equal(windowsRunner.shell, false, 'resolved .cmd paths should not require cmd.exe or shell quoting');

  const firstScenario = { id: 's1', arguments: [1], mocks: [], target: { branchId: 'b1', outcome: true } };
  const pairFalse = { arguments: [0], mocks: [], atomicConditionValues: { c1: false }, decisionOutcome: false };
  const pairTrue = { arguments: [1], mocks: [], atomicConditionValues: { c1: true }, decisionOutcome: true };
  const collected = collectCoverageExecutionCases([{
    name: 'target', parameters: [{ name: 'value', supported: true }], scenarios: [firstScenario],
    mcdc: { decisions: [{ decisionId: 'd1', expression: 'value', conditions: [{ id: 'c1', expression: 'value',
      independencePairs: [{ pairId: 'p1', scenarios: { conditionFalse: pairFalse, conditionTrue: pairTrue } }] }] }] },
  }]);
  assert.equal(collected.cases.length, 2, 'identical argument/mocks payloads are deduplicated');
  assert.equal(collected.pairRecords.length, 1);
  assert.equal(collected.cases.find(item => item.arguments[0] === 1).references.length, 2);
  const expectedThrow = { name: 'RangeError', source: "new RangeError('negative age')" };
  const thrownCases = collectCoverageExecutionCases([{ name: 'throws', scenarios: [{ id: 'throw-1', arguments: [-1], mocks: [], expectedException: expectedThrow, target: { branchId: 'throw-branch', outcome: true } }] }]);
  assert.deepEqual(thrownCases.cases[0].expectedException, expectedThrow, 'expected exception metadata must survive case collection');

  const harness = buildJestFeedbackTest(sourceFile, 'target', null, 'in.json', 'runtime.json', [{ name: 'target' }], collected.cases, '/* runtime-recorder-fixture */');
  assert.ok(harness.includes('/* runtime-recorder-fixture */'));
  assert.ok(harness.includes('Generated by branch-scenarios-generator'));
  assert.ok(harness.includes('Reflect.apply(targetFunction, targetReceiver, tracked.args)'));
  assert.ok(harness.includes('let targetReceiver;'), 'harness must preserve the owning object for exported methods');
  assert.ok(harness.includes('let didThrow = false;'), 'runtime harness must distinguish falsy thrown values from no exception');
  assert.ok(harness.includes('if (didThrow) throw thrownValue;'), 'unexpected falsy exceptions must fail the test rather than pass silently');
  assert.ok(harness.includes('expectedException.primitive'), 'primitive throws must be compared by exact value');
  assert.ok(harness.includes('cannot be verified safely'), 'unknown thrown expressions must not accept arbitrary exceptions');
  assert.ok(harness.includes('jestApi.clearAllMocks()'), 'harness should preserve setup-file mock implementations');

  const jestResultsPath = path.join(temp, 'jest-results.json');
  fs.writeFileSync(jestResultsPath, JSON.stringify({ success: true, numTotalTests: 2, numPassedTests: 1, numFailedTests: 1,
    testResults: [{ assertionResults: [
      { fullName: collected.cases[0].testName, status: 'passed' },
      { fullName: collected.cases[1].testName, status: 'failed', failureMessages: ['expected'] },
    ] }] }));
  const testResults = readJestTestResults(jestResultsPath, collected.cases, fs);
  assert.deepEqual(testResults.cases.map(item => item.status), ['passed', 'failed']);
  assert.equal(testResults.numFailedTests, 1);
  const duplicateTitleCases = [
    { id: 'same-a', testName: 'same display name', references: [] },
    { id: 'same-b', testName: 'same display name', references: [] },
  ];
  const duplicateTitlePath = path.join(temp, 'duplicate-title-results.json');
  fs.writeFileSync(duplicateTitlePath, JSON.stringify({ success: true, testResults: [{ assertionResults: [
    { fullName: 'same display name [scenario:same-b]', status: 'passed' },
    { fullName: 'same display name [scenario:same-a]', status: 'failed', failureMessages: ['specific failure'] },
  ] }] }));
  const duplicateResults = readJestTestResults(duplicateTitlePath, duplicateTitleCases, fs);
  assert.deepEqual(duplicateResults.cases.map(item => item.status), ['failed', 'passed'], 'scenario IDs, not display titles, must determine result attribution');
  assert.deepEqual(readRuntimeTraceFile(path.join(temp, 'missing.json'), { fs, fallback: ['fallback'] }), ['fallback']);
  const tracePath = path.join(temp, 'trace.json');
  fs.writeFileSync(tracePath, '[{"caseId":"s1"}]');
  assert.deepEqual(readRuntimeTraceFile(tracePath, { fs }), [{ caseId: 's1' }]);

  const sourceMap = createSourceMapNormalizer({ fs, path, platform: 'linux' });
  const instrumentedPath = path.join(temp, 'target.instrumented.js');
  const originalText = 'if (value) return true;';
  const remapped = sourceMap.remapCoverageMapForInstrumentedSource({ [instrumentedPath]: {
    branchMap: { 0: { loc: { start: { line: 1, column: 12 }, end: { line: 1, column: 30 } }, locations: [] } },
    statementMap: { 0: { start: { line: 1, column: 13 }, end: { line: 1, column: 30 } } },
    fnMap: { 0: { loc: { start: { line: 1, column: 13 }, end: { line: 1, column: 30 } }, decl: { start: { line: 1, column: 13 }, end: { line: 1, column: 30 } } } },
    l: { 1: 1 },
  } }, instrumentedPath, sourceFile, originalText, {
    generatedSource: '/* wrapped */if (value) return true;',
    insertionEvents: [{ generatedStart: 0, generatedEnd: 13, originalOffset: 0 }],
  });
  assert.equal(remapped.remapped, true);
  assert.equal(remapped.coverageMap[sourceFile].branchMap[0].loc.start.column, 0);
  assert.equal(remapped.coverageMap[sourceFile].statementMap[0].start.column, 0, 'statementMap coordinates must be remapped too');
  assert.equal(remapped.coverageMap[sourceFile].fnMap[0].loc.start.column, 0, 'fnMap coordinates must be remapped too');
  assert.equal(Object.hasOwn(remapped.coverageMap[sourceFile], 'l'), false, 'generated line counters must be rebuilt from remapped statement locations');

  const normalizer = createSourceMapNormalizer({ fs, path, platform: 'linux' });
  const mapper = createBranchMapper({ fs, path, platform: 'linux', canonicalCoveragePath: normalizer.canonicalCoveragePath });
  const functionResults = [{ name: 'target', scenarios: [{ id: 's-true', target: {
    branchId: 'b1', kind: 'if', condition: 'value', outcome: true, line: 1, column: 3,
    coverageLine: 1, coverageColumn: 3, coverageOutcomeIndex: 0,
  } }, { id: 's-false', target: {
    branchId: 'b1', kind: 'if', condition: 'value', outcome: false, line: 1, column: 3,
    coverageLine: 1, coverageColumn: 3, coverageOutcomeIndex: 1,
  } }] }];
  const fileCoverage = { branchMap: { 0: { type: 'if', loc: { start: { line: 1, column: 2 }, end: { line: 1, column: 24 } }, locations: [] } }, b: { 0: [2, 0] } };
  const mapped = mapper.mapCoverageBranches(fileCoverage, functionResults);
  assert.equal(mapped.targets[0].coverageStatus, 'partially-covered');
  assert.equal(mapped.targets[0].coverageOutcomes[0].covered, true);

  const builder = createCoverageFeedbackBuilder({
    path, summarizeCounterMap, normalizeCoverageFileMap: mapper.normalizeCoverageFileMap,
    mapCoverageBranches: mapper.mapCoverageBranches, collectStaticBranchTargets: mapper.collectStaticBranchTargets,
  });
  const coverageMap = { [sourceFile]: { ...fileCoverage, s: { 0: 1 }, f: { 0: 1 }, l: { 1: 2 } } };
  const coverageMapPath = path.join(temp, 'coverage-final.json');
  fs.writeFileSync(coverageMapPath, JSON.stringify(coverageMap));
  const feedback = builder.buildCoverageFeedback(readIstanbulCoverage(coverageMapPath, fs), sourceFile, functionResults);
  assert.equal(feedback.status, 'coverage-loaded');
  assert.equal(feedback.branchCoverage.staticTargetsPartiallyCovered, 1);
  assert.equal(readIstanbulCoverage(coverageMapPath, fs)[sourceFile].b[0][0], 2);

  const attribution = buildScenarioCoverageAttribution(
    [{ id: 'case-1', testName: 'case 1', arguments: [1], references: [] }],
    { cases: [{ id: 'case-1', status: 'passed' }] },
    [{ caseId: 'case-1', decisionId: 'd1', decisionOutcome: true, executionStatus: 'completed', conditions: { c1: { evaluated: true, value: true } } }],
    [{ name: 'target', scenarios: [{ target: { runtimeDecisionId: 'd1', branchId: 'b1' } }] }],
    [],
  );
  assert.equal(attribution.casesWithBranchAttribution, 1);
  assert.equal(attribution.cases[0].coveredBranchOutcomes[0].branchId, 'b1');

  console.log('Execution/Coverage module tests passed: Jest runner, case collection, harness, readers, Istanbul remapping, branch mapping and scenario attribution.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
