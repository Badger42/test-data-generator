import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createCoverageFeedbackUseCase } from '../src/application/run-coverage-feedback.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-timeout-usecase-'));
const sourceFile = path.join(root, 'target.js');
const outputFile = path.join(root, 'report.json');
fs.writeFileSync(sourceFile, 'export function target(value) { return value; }');

function makeUseCase({ runJest, buildJestFeedbackTest = () => '/* generated test */', processContext = process }) {
  return createCoverageFeedbackUseCase({
    fs, path, process: processContext, runJest,
    collectCoverageExecutionCases: () => ({
      cases: [{ id: 'scenario-1', arguments: [true], mocks: [], references: [] }], pairRecords: [],
    }),
    findJestRunner: () => ({ command: 'jest', prefixArgs: [], shell: false, version: '30.5.2' }),
    resolveJestWorkingDirectory: () => root,
    instrumentMcdcSource: () => { throw new Error('MC/DC should not be enabled in this test'); },
    buildJestFeedbackTest,
    runtimeRecorderSource: '',
    readJestTestResults: () => null,
    readIstanbulCoverage: () => null,
    remapCoverageMapForInstrumentedSource: () => ({ remapped: false, coverageMap: {} }),
    buildCoverageFeedback: () => ({ version: 1, status: 'passed' }),
    readRuntimeTraceFile: () => [],
    verifyRuntimeMcdcSide: () => ({ status: 'not-verified' }),
    buildScenarioCoverageAttribution: () => ({}),
  });
}

try {
  const calls = [];
  const timedOutRun = () => {
    calls.push({});
    const error = new Error('spawnSync jest ETIMEDOUT');
    error.code = 'ETIMEDOUT';
    return { status: null, signal: 'SIGTERM', pid: 43210, error, stdout: '', stderr: '' };
  };
  const useCase = makeUseCase({ runJest: timedOutRun });
  const args = { jestBin: null, jestConfig: null, jestSetup: null, mcdc: false,
    coverageProvider: 'v8', testBatching: false, jestTimeoutMs: 50, coverageFeedbackTimeoutMs: 25 };
  const first = useCase.createCoverageFeedback({ functions: [{ name: 'target', scenarios: [] }] }, sourceFile, outputFile, args);
  assert.equal(first.status, 'execution-timeout');
  assert.equal(first.jest.timedOut, true);
  assert.equal(first.jest.timeoutMs, 25, 'a Jest pass must not exceed the remaining total feedback budget');
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.branch-scenarios-feedback-')), false,
    'temporary files must be removed after timeout');

  await new Promise(resolve => setTimeout(resolve, 35));
  const second = useCase.createCoverageFeedback({ functions: [{ name: 'target', scenarios: [] }] }, sourceFile, outputFile, args);
  assert.equal(second.status, 'execution-timeout', 'the same args object must retain one total budget across iterative passes');
  assert.equal(calls.length, 1, 'an exhausted total budget must prevent another Jest process from starting');


  const windowsCalls = [];
  const windowsUseCase = makeUseCase({
    processContext: { ...process, platform: 'win32' },
    runJest: (command, args) => {
      windowsCalls.push({ command, args });
      if (command === 'taskkill') return { status: 0, stdout: '', stderr: '' };
      const error = new Error('spawnSync jest ETIMEDOUT');
      error.code = 'ETIMEDOUT';
      return { status: null, signal: 'SIGTERM', pid: 9876, error, stdout: '', stderr: '' };
    },
  });
  const windowsTimeout = windowsUseCase.createCoverageFeedback(
    { functions: [{ name: 'target', scenarios: [] }] }, sourceFile, outputFile,
    { jestBin: null, jestConfig: null, jestSetup: null, mcdc: false, coverageProvider: 'v8', testBatching: false, jestTimeoutMs: 20 },
  );
  assert.equal(windowsTimeout.status, 'execution-timeout');
  assert.ok(windowsCalls.some(call => call.command === 'taskkill' && call.args.includes('/t') && call.args.includes('/f')),
    'Windows timeout must terminate the Jest child process tree, not only its parent process');

  const harnessErrorCase = makeUseCase({
    runJest: () => { throw new Error('must not launch'); },
    buildJestFeedbackTest: () => { throw new Error('synthetic harness build failure'); },
  });
  const harnessError = harnessErrorCase.createCoverageFeedback(
    { functions: [{ name: 'target', scenarios: [] }] }, sourceFile, outputFile,
    { jestBin: null, jestConfig: null, jestSetup: null, mcdc: false, coverageProvider: 'v8', testBatching: false },
  );
  assert.equal(harnessError.status, 'jest-harness-generation-error');
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.branch-scenarios-feedback-')), false,
    'temporary files must be removed when harness generation throws');
  console.log('Coverage Feedback timeout tests passed: per-pass deadline, shared total budget, and temp cleanup on timeout/build failure.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
