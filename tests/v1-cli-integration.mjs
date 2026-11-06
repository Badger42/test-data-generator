import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-v1-'));
try {
  const output = path.join(temp, 'report.json');
  const run = spawnSync(process.execPath, [
    path.join(project, 'branch-scenarios.mjs'), path.join(project, 'examples/passenger.ts'),
    '--all', '--include-evidence', '--constraint-diagnostics', '--analysis-report', '--out', output,
  ], { cwd: project, encoding: 'utf8' });
  assert.equal(run.status, 0, `CLI integration failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.generator.name, 'branch-scenarios-generator');
  assert.equal(report.generator.version, '1.0.0-rc.7');
  assert.ok(report.functions.length >= 1);
  const scenarios = report.functions.flatMap(fn => fn.scenarios);
  assert.ok(scenarios.length > 0);
  const evidenceScenarios = scenarios.filter(scenario => scenario.evidence?.length);
  assert.ok(evidenceScenarios.length > 0, 'include-evidence must carry static evidence through the full production pipeline');
  assert.ok(evidenceScenarios.flatMap(scenario => scenario.evidence).every(item => item.status !== 'verified'), 'static facts must not claim runtime verification');
  const mockActions = scenarios.flatMap(scenario => scenario.mocks ?? []);
  assert.ok(mockActions.some(action => action.inputDependencies?.length), 'mock argument dependencies must survive ScenarioCase and report projection');
  assert.ok(mockActions.every(action => action.evidence?.every(item => item.status !== 'verified')), 'static mock evidence must not claim runtime verification');
  assert.ok(report.constraintEngine, 'constraint diagnostics should be included in the report');
  const analysisReportPath = output.replace(/\.json$/i, '') + '.analysis-report.json';
  const analysisReport = JSON.parse(fs.readFileSync(analysisReportPath, 'utf8'));
  assert.equal(analysisReport.reportType, 'branch-scenarios-analysis-report');
  assert.equal(analysisReport.privacy.valueMode, 'shape');
  assert.equal(analysisReport.privacy.absolutePathsIncluded, false);
  assert.ok(analysisReport.project.functionIndex.total >= report.functions.length);
  assert.ok(analysisReport.functions.some(fn => fn.dataFlow?.pointsTo));
  assert.ok(analysisReport.externalExecution);
  assert.equal(analysisReport.execution.status, 'not-run');
  const executionFormPath = output.replace(/\.json$/i, '') + '.analysis-run-form.json';
  const executionForm = JSON.parse(fs.readFileSync(executionFormPath, 'utf8'));
  assert.equal(executionForm.reportId, analysisReport.reportId);
  assert.equal(executionForm.formType, 'branch-scenarios-execution-results-form');
  assert.ok(executionForm.testResults.cases.length > 0);
  assert.ok(executionForm.testResults.cases.every(item => item.status === 'not-run'));
  assert.equal(executionForm.completion.ready, true);
  assert.equal(analysisReport.externalExecution.executionForm.file, path.basename(executionFormPath));

  const customOutput = path.join(temp, 'custom-run.scenarios.json');
  const customForm = path.join(temp, 'forms', 'execution-results.json');
  fs.mkdirSync(path.dirname(customForm), { recursive: true });
  const customRun = spawnSync(process.execPath, [
    path.join(project, 'branch-scenarios.mjs'), path.join(project, 'examples/passenger.ts'),
    '--all', '--analysis-report-form-out', customForm, '--out', customOutput,
  ], { cwd: project, encoding: 'utf8' });
  assert.equal(customRun.status, 0, `custom execution form output failed:\n${customRun.stdout}\n${customRun.stderr}`);
  const customAnalysisReport = JSON.parse(fs.readFileSync(customOutput.replace(/\.json$/i, '.analysis-report.json'), 'utf8'));
  assert.equal(customAnalysisReport.externalExecution.executionForm.file, 'forms/execution-results.json');
  assert.ok(fs.existsSync(customForm));
  console.log(`v1 CLI integration passed: ${scenarios.length} scenarios, ${evidenceScenarios.length} with static Data Flow evidence.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
