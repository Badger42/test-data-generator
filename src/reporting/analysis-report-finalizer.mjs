import { assertAnalysisReport } from './analysis-report-schema.mjs';
import { assertAnalysisRunForm } from './analysis-run-form-schema.mjs';
import { relativeArtifactPath } from './analysis-run-form.mjs';

function totalsFromCases(cases, additionalCases = []) {
  const allCases = [...cases, ...additionalCases];
  const counts = { total: allCases.length, passed: 0, failed: 0, skipped: 0, pending: 0, notRun: 0 };
  for (const item of allCases) {
    if (item.status === 'passed') counts.passed += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else if (item.status === 'skipped') counts.skipped += 1;
    else if (item.status === 'pending') counts.pending += 1;
    else counts.notRun += 1;
  }
  return counts;
}

function redactText(value) {
  if (value == null) return null;
  return String(value)
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s)\]]+/g, '<absolute-path>')
    .replace(/\b[A-Za-z0-9_+/=-]{28,}\b/g, '<redacted-token>')
    .slice(0, 4000);
}

function cleanMetric(metric) {
  return {
    covered: Number.isFinite(metric?.covered) ? metric.covered : null,
    total: Number.isFinite(metric?.total) ? metric.total : null,
    pct: Number.isFinite(metric?.pct) ? metric.pct : null,
  };
}

function cleanArtifacts(artifacts) {
  const clean = {};
  for (const key of ['junitXml', 'jestJson', 'coverageFinalJson', 'consoleLog']) clean[key] = relativeArtifactPath(artifacts?.[key]);
  clean.custom = (artifacts?.custom ?? []).map(item => ({
    name: String(item.name ?? 'artifact').slice(0, 120),
    path: relativeArtifactPath(item.path),
    description: typeof item.description === 'string' ? redactText(item.description)?.slice(0, 500) : null,
  })).filter(item => item.path);
  return clean;
}

/** Merge a filled execution form into the static analysis report. Never mutates inputs. */
export function finalizeAnalysisReport(analysisReport, executionForm) {
  assertAnalysisReport(analysisReport);
  assertAnalysisRunForm(executionForm);
  if (analysisReport.reportId !== executionForm.reportId) throw new Error('Execution form reportId does not match the analysis report.');
  const expectedFingerprint = analysisReport.project?.fingerprint ?? analysisReport.project?.source?.projectFingerprint ?? null;
  if (expectedFingerprint && executionForm.project?.projectFingerprint !== expectedFingerprint) throw new Error('Execution form project fingerprint does not match the analysis report.');

  const known = new Set((analysisReport.functions ?? []).flatMap(fn => [
    ...(fn.scenarioIndex?.ids ?? []), ...(fn.scenarios ?? []).map(item => item.id),
  ].map(id => `${fn.functionId ?? ''}|${id}`)));
  const scenarios = executionForm.testResults.cases;
  const additionalCases = executionForm.testResults.additionalTestsNotLinkedToScenarios ?? [];
  const caseKeys = scenarios.map(item => `${item.functionId ?? ''}|${item.scenarioId}`);
  if (new Set(caseKeys).size !== caseKeys.length) throw new Error('Execution form contains duplicate scenario/function IDs.');
  const unknownCases = scenarios.filter(item => !known.has(`${item.functionId ?? ''}|${item.scenarioId}`) && !known.has(`|${item.scenarioId}`));
  if (unknownCases.length) throw new Error(`Execution form contains ${unknownCases.length} scenario ID(s) not present in the analysis report.`);

  const counts = totalsFromCases(scenarios, additionalCases);
  const declared = executionForm.testResults;
  const countDiscrepancies = ['total', 'passed', 'failed', 'pending', 'skipped']
    .filter(key => Number.isInteger(declared[key]) && declared[key] !== counts[key])
    .map(key => ({ field: key, declared: declared[key], derivedFromCases: counts[key] }));
  const allExecuted = counts.notRun === 0 && (executionForm.testResults.truncatedCases ?? 0) === 0 && scenarios.length > 0;
  const execution = executionForm.execution;
  const coverage = executionForm.coverage;
  const result = JSON.parse(JSON.stringify(analysisReport));
  result.externalExecution = {
    ...result.externalExecution,
    status: execution.status === 'captured-by-generator' ? 'captured-by-generator' : allExecuted ? 'manually-recorded' : 'partially-recorded',
    runner: redactText(execution.runner),
    executedAt: execution.completedAt ?? new Date().toISOString(),
    startedAt: execution.startedAt ?? null,
    completedAt: execution.completedAt ?? null,
    durationMs: Number.isFinite(execution.durationMs) ? execution.durationMs : null,
    testCommand: redactText(execution.command),
    environment: execution.environment ? {
      node: redactText(execution.environment.node), jest: redactText(execution.environment.jest),
      typescript: redactText(execution.environment.typescript), platform: redactText(execution.environment.platform),
      architecture: redactText(execution.environment.architecture), coverageProvider: redactText(execution.environment.coverageProvider),
    } : null,
    testResults: {
      total: Number.isInteger(executionForm.testResults.total) ? executionForm.testResults.total : counts.total,
      passed: Number.isInteger(executionForm.testResults.passed) ? executionForm.testResults.passed : counts.passed,
      failed: Number.isInteger(executionForm.testResults.failed) ? executionForm.testResults.failed : counts.failed,
      pending: Number.isInteger(executionForm.testResults.pending) ? executionForm.testResults.pending : counts.pending,
      skipped: Number.isInteger(executionForm.testResults.skipped) ? executionForm.testResults.skipped : counts.skipped,
      notRun: counts.notRun,
      plannedCases: executionForm.testResults.plannedCases,
      truncatedCases: executionForm.testResults.truncatedCases ?? 0,
      consistency: { derivedFromCases: counts, discrepancies: countDiscrepancies },
      cases: scenarios.map(item => ({
        scenarioId: item.scenarioId,
        functionId: item.functionId ?? null,
        branchId: item.branchId ?? null, outcome: typeof item.outcome === 'boolean' ? item.outcome : null,
        batchId: item.batchId ?? null,
        status: item.status,
        durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
        testName: redactText(item.testName),
        failureMessages: item.failure?.message ? [redactText(item.failure.message)] : [],
        failureName: redactText(item.failure?.name),
        stack: redactText(item.failure?.stack),
      })),
      additionalTestsNotLinkedToScenarios: additionalCases.map(item => ({
        name: redactText(item.name), status: item.status ?? 'unknown', durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
        message: redactText(item.message),
      })),
    },
    coverage: {
      provider: coverage.provider ?? execution.environment?.coverageProvider ?? null,
      reportPath: relativeArtifactPath(coverage.reportPath),
      metrics: {
        statements: cleanMetric(coverage.metrics?.statements), branches: cleanMetric(coverage.metrics?.branches),
        functions: cleanMetric(coverage.metrics?.functions), lines: cleanMetric(coverage.metrics?.lines),
      },
      uncovered: (coverage.uncovered ?? []).map(item => ({
        id: item.id ?? null, branchId: item.branchId ?? null, file: relativeArtifactPath(item.file),
        line: Number.isInteger(item.line) ? item.line : null, outcome: item.outcome ?? null, reason: redactText(item.reason),
      })),
      notes: (coverage.notes ?? []).map(redactText),
    },
    failingTests: scenarios.filter(item => item.status === 'failed').map(item => ({
      scenarioId: item.scenarioId, functionId: item.functionId ?? null, branchId: item.branchId ?? null,
      name: redactText(item.failure?.name), message: redactText(item.failure?.message), stack: redactText(item.failure?.stack),
    })),
    artifacts: cleanArtifacts(executionForm.artifacts),
    notes: [...(executionForm.notes ?? []).map(redactText), ...(executionForm.issues ?? []).map(item => redactText(`[${item.severity ?? 'issue'}] ${item.message ?? item.code ?? 'Issue'}`))],
    manualForm: { status: allExecuted ? 'completed' : 'partial', completedAt: new Date().toISOString() },
    fillInWhenRunningTestsManually: [],
  };
  result.privacy = { ...result.privacy, manualExecutionDataIncluded: true, reviewRequired: true, note: `${result.privacy.note} Manually entered execution details were merged; review test names, failure messages and notes before sharing.` };
  result.assistantHandoff = {
    ...result.assistantHandoff,
    recommendedAttachments: [...new Set([...(result.assistantHandoff?.recommendedAttachments ?? []), ...Object.values(result.externalExecution.artifacts).filter(value => typeof value === 'string' && value)])],
  };
  return assertAnalysisReport(result);
}
