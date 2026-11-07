import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnalysisRunForm } from '../src/reporting/analysis-run-form.mjs';
import { validateAnalysisRunForm } from '../src/reporting/analysis-run-form-schema.mjs';
import { finalizeAnalysisReport } from '../src/reporting/analysis-report-finalizer.mjs';
import { runFinalizeAnalysisReport } from '../tools/finalize-analysis-report.mjs';

const analysisReport = {
  reportType: 'branch-scenarios-analysis-report', schemaVersion: '1.0.0', reportId: 'report-abc123',
  generatedAt: '2026-11-05T10:00:00.000Z', generator: { name: 'branch-scenarios-generator', version: '1.0.0-rc.6' },
  environment: { node: 'v22.16.0', platform: 'linux', architecture: 'x64', typescript: '5.8.3' },
  project: { root: '.', fingerprint: 'b'.repeat(64), source: { file: 'src/app.ts', sha256: 'a'.repeat(64), projectFingerprint: 'b'.repeat(64) }, sourceFileCount: 2 },
  run: { valueMode: 'shape' }, summary: { scenarios: 2 },
  functions: [{ functionId: 'src/app.ts::run@0', name: 'run', scenarios: [
    { id: 'scenario-1', target: { branchId: 'if-1', outcome: true } },
    { id: 'scenario-2', target: { branchId: 'if-1', outcome: false } },
  ] }],
  callGraph: { edgeCount: 0, edges: [] }, execution: { status: 'not-run' },
  externalExecution: { status: 'not-recorded', failingTests: [], notes: [], fillInWhenRunningTestsManually: [] },
  diagnostics: { project: [], functions: [] },
  privacy: { valueMode: 'shape', valuesIncluded: false, sourceCodeIncluded: false, sourceExpressionsIncluded: false, absolutePathsIncluded: false, note: 'redacted' },
  assistantHandoff: { recommendedAttachments: [], reviewQuestions: [] },
};
const functionResults = [{ name: 'run', scenarios: [
  { id: 'scenario-1', target: { branchId: 'if-1', outcome: true } },
  { id: 'scenario-2', target: { branchId: 'if-1', outcome: false } },
] }];

const capturedForm = createAnalysisRunForm({
  analysisReport,
  functionResults,
  coverageFeedback: {
    runner: 'jest',
    execution: {
      testResults: {
        numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
        cases: [{
          id: 'coverage-case-1',
          status: 'passed',
          title: '[Branch Scenario] shared',
          references: [{ scenarioId: 'scenario-1' }, { scenarioId: 'scenario-2' }],
        }],
      },
      testBatching: { batches: [{ id: 'batch-0001', scenarioIds: ['coverage-case-1'] }], individual: [] },
    },
  },
});
assert.deepEqual(capturedForm.testResults.cases.map(item => item.status), ['passed', 'passed'],
  'one deduplicated execution case must update every linked scenario');
assert.deepEqual(capturedForm.testResults.cases.map(item => item.batchId), ['batch-0001', 'batch-0001']);
assert.equal(capturedForm.testResults.total, 1, 'executed-case count remains distinct from planned scenario count');
assert.equal(capturedForm.execution.status, 'captured-by-generator');

const form = createAnalysisRunForm({ analysisReport, functionResults });
assert.equal(validateAnalysisRunForm(form).valid, true);
assert.equal(form.testResults.total, null, 'unexecuted scenarios must not be represented as zero passed tests');
assert.equal(form.testResults.plannedCases, 2);
assert.deepEqual(form.testResults.cases.map(item => item.status), ['not-run', 'not-run']);
assert.equal(form.execution.status, 'awaiting-manual-run');

form.execution.command = 'npm test -- --runInBand';
form.execution.runner = 'jest';
form.execution.environment.node = 'v22.16.0';
form.execution.environment.jest = '30.0.0';
form.execution.startedAt = '2026-11-05T10:00:00.000Z';
form.execution.completedAt = '2026-11-05T10:00:02.000Z';
form.execution.durationMs = 2000;
form.testResults.cases[0].status = 'passed';
form.testResults.cases[0].durationMs = 20;
form.testResults.cases[1].status = 'failed';
form.testResults.cases[1].failure = { name: 'AssertionError', message: 'Expected: 1, received: 2', stack: 'at test (C:\\Users\\alice\\project\\test.js:5:2)' };
form.coverage.provider = 'v8';
form.coverage.reportPath = 'coverage/coverage-final.json';
form.coverage.metrics.branches = { covered: 8, total: 10, pct: 80 };
form.artifacts.junitXml = 'reports/junit.xml';
form.artifacts.coverageFinalJson = 'coverage/coverage-final.json';
form.notes.push('Failure reproduced locally.');

const finalized = finalizeAnalysisReport(analysisReport, form);
assert.equal(finalized.externalExecution.status, 'manually-recorded');
assert.equal(finalized.externalExecution.testResults.total, 2);
assert.equal(finalized.externalExecution.testResults.passed, 1);
assert.equal(finalized.externalExecution.testResults.failed, 1);
assert.equal(finalized.externalExecution.coverage.metrics.branches.pct, 80);
assert.equal(finalized.externalExecution.artifacts.junitXml, 'reports/junit.xml');
assert.match(finalized.externalExecution.failingTests[0].stack, /<absolute-path>/);
assert.equal(finalized.privacy.reviewRequired, true);
assert.deepEqual(analysisReport.externalExecution.failingTests, [], 'finalizer must not mutate the original report');

const mismatched = { ...form, reportId: 'another-report' };
assert.throws(() => finalizeAnalysisReport(analysisReport, mismatched), /reportId does not match/);
const mismatchedProject = { ...form, project: { ...form.project, projectFingerprint: 'c'.repeat(64) } };
assert.throws(() => finalizeAnalysisReport(analysisReport, mismatchedProject), /project fingerprint does not match/);
const unknownCase = { ...form, testResults: { ...form.testResults, cases: [{ ...form.testResults.cases[0], scenarioId: 'missing-scenario' }] } };
assert.throws(() => finalizeAnalysisReport(analysisReport, unknownCase), /not present in the analysis report/);
const invalidArtifact = { ...form, artifacts: { ...form.artifacts, junitXml: 'C:\\secret\\junit.xml' } };
const cleaned = finalizeAnalysisReport(analysisReport, invalidArtifact);
assert.equal(cleaned.externalExecution.artifacts.junitXml, null, 'absolute artifact paths must not be included');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-run-form-'));
try {
  const reportPath = path.join(temp, 'analysis-report.json');
  const formPath = path.join(temp, 'execution-form.json');
  const outputPath = path.join(temp, 'final-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(analysisReport));
  fs.writeFileSync(formPath, JSON.stringify(form));
  const cliResult = runFinalizeAnalysisReport([reportPath, formPath, '--out', outputPath], { log: () => {} });
  assert.equal(cliResult.status, 'finalized');
  assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).externalExecution.testResults.failed, 1);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('Analysis run form tests passed: scenario linking, manual results, coverage merge, path redaction and reportId validation.');
