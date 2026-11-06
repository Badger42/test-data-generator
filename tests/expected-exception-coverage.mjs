import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-expected-exception-'));
const output = path.join(temp, 'throw-feedback.json');
const fakeCommand = path.join(temp, 'fake-jest');
const fakeRunner = path.join(root, 'tests', 'fixtures', 'fake-jest-runner.cjs');
const source = path.join(root, 'examples', 'coverage-feedback-throw-target.js');
try {
  fs.writeFileSync(fakeCommand, `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(fakeCommand, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(root, 'branch-scenarios.mjs'), source,
    '--function', 'throwOnNegative', '--mcdc', '--coverage-feedback',
    '--jest-bin', fakeCommand, '--out', output,
  ], { cwd: root, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, `Expected-throw feedback failed:\n${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.coverageFeedback.status, 'passed');
  const throwingScenario = report.functions[0].scenarios.find(scenario => scenario.expectedException?.name === 'RangeError');
  assert.ok(throwingScenario, 'the throw branch should be annotated with the expected RangeError');
  const runtimeCase = report.coverageFeedback.execution.testResults.cases.find(item =>
    item.references.some(reference => reference.scenarioId === throwingScenario.id));
  assert.ok(runtimeCase, 'throw branch must be included in runtime execution cases');
  assert.equal(runtimeCase.status, 'passed', 'expected throw must be recorded as a passing test result');
  assert.equal(report.coverageFeedback.execution.testResults.numFailedTests, 0);
  assert.equal(report.coverageFeedback.execution.testResults.numPassedTests, report.coverageFeedback.execution.generatedCases);
  console.log('Expected exception coverage passed: thrown branch recorded as a passing runtime outcome without losing sibling cases.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
