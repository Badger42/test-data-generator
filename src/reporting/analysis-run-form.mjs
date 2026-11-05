import { assertAnalysisRunForm, ANALYSIS_RUN_FORM_SCHEMA_VERSION } from './analysis-run-form-schema.mjs';

const EXECUTED_STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'not-run']);

function caseStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (['passed', 'pass', 'success', 'successful'].includes(status)) return 'passed';
  if (['failed', 'fail', 'error'].includes(status)) return 'failed';
  if (['skipped', 'skip', 'todo'].includes(status)) return 'skipped';
  if (['pending', 'todo-pending'].includes(status)) return 'pending';
  return 'not-run';
}

function relativeArtifactPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Artifact paths are intentionally project-relative. Absolute paths are not
  // copied into the shareable form.
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.includes('..')) return null;
  return normalized;
}

function coverageMetric(metric) {
  if (!metric || typeof metric !== 'object') return { covered: null, total: null, pct: null };
  return {
    covered: Number.isFinite(metric.covered) ? metric.covered : null,
    total: Number.isFinite(metric.total) ? metric.total : null,
    pct: Number.isFinite(metric.pct) ? metric.pct : null,
  };
}

/** Builds a fillable, scenario-linked form for a test run performed outside the generator. */
export function createAnalysisRunForm(input) {
  const { analysisReport, functionResults = [], coverageFeedback = null } = input;
  if (!analysisReport?.reportId) throw new TypeError('AnalysisRunForm requires an analysisReport with reportId.');

  const capturedResults = coverageFeedback?.execution?.testResults ?? null;
  const capturedById = new Map((capturedResults?.cases ?? []).map(item => [item.id, item]));
  const batching = coverageFeedback?.execution?.testBatching;
  const batchByScenario = new Map();
  for (const batch of batching?.batches ?? []) {
    for (const scenarioId of batch.scenarioIds ?? []) batchByScenario.set(scenarioId, batch.id);
  }

  const totalPlannedCases = functionResults.reduce((total, result) => total + (result.scenarios?.length ?? 0), 0);
  const cases = [];
  const maxCases = Math.max(1, Math.min(50000, input.maxCases ?? 20000));
  let truncatedCases = 0;
  outer: for (const [index, result] of functionResults.entries()) {
    const functionId = analysisReport.functions[index]?.functionId ?? null;
    const functionName = result.name ?? analysisReport.functions[index]?.name ?? 'anonymous';
    for (const scenario of result.scenarios ?? []) {
      if (cases.length >= maxCases) { truncatedCases = totalPlannedCases - cases.length; break outer; }
      const captured = capturedById.get(scenario.id);
      const target = scenario.target ?? {};
      const status = captured ? caseStatus(captured.status) : 'not-run';
      cases.push({
        scenarioId: scenario.id,
        functionId,
        functionName,
        branchId: target.branchId ?? null,
        outcome: typeof target.outcome === 'boolean' ? target.outcome : null,
        testName: captured?.title ?? scenario.testName ?? `${functionName} :: ${scenario.id}`,
        batchId: batchByScenario.get(scenario.id) ?? null,
        status,
        durationMs: Number.isFinite(captured?.durationMs) ? captured.durationMs : null,
        failure: status === 'failed' ? {
          name: captured?.failureName ?? null,
          message: (captured?.failureMessages ?? []).slice(0, 3).join('\n') || null,
          stack: null,
        } : { name: null, message: null, stack: null },
        notes: [],
      });
    }
  }

  const counts = cases.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  const captured = Boolean(capturedResults);
  const totals = coverageFeedback?.totals ?? null;
  const form = {
    formType: 'branch-scenarios-execution-results-form',
    schemaVersion: ANALYSIS_RUN_FORM_SCHEMA_VERSION,
    reportId: analysisReport.reportId,
    generatedAt: new Date().toISOString(),
    generatorVersion: analysisReport.generator.version,
    project: {
      source: analysisReport.project.source.file,
      sourceSha256: analysisReport.project.source.sha256,
      projectFingerprint: analysisReport.project.fingerprint ?? analysisReport.project.source.projectFingerprint ?? null,
      sourceFileCount: analysisReport.project.sourceFileCount,
    },
    instructions: [
      'Run the generated tests in the target project, then fill execution, testResults, coverage, artifacts and notes.',
      'Keep scenarioId unchanged; it links each result to the corresponding analysis scenario.',
      'Use project-relative artifact paths. Do not paste absolute paths, secrets, tokens or production data.',
      'For a failing test, include the assertion/error message and a short relevant stack. Redact real input values.',
      'If a scenario was not executed, keep status as not-run; do not mark static evidence as runtime-verified.',
      'Upload this completed form together with the matching *.analysis-report.json. The finalizer validates reportId before merging.',
    ],
    execution: {
      status: captured ? 'captured-by-generator' : 'awaiting-manual-run',
      runner: coverageFeedback?.runner ?? 'jest',
      command: null,
      startedAt: null,
      completedAt: captured ? new Date().toISOString() : null,
      durationMs: null,
      environment: {
        node: null,
        jest: null,
        typescript: analysisReport.environment.typescript ?? null,
        platform: null,
        architecture: null,
        coverageProvider: coverageFeedback?.provider ?? null,
      },
    },
    testResults: {
      total: captured ? (capturedResults.numTotalTests ?? cases.length) : null,
      passed: captured ? (capturedResults.numPassedTests ?? counts.passed ?? 0) : null,
      failed: captured ? (capturedResults.numFailedTests ?? counts.failed ?? 0) : null,
      skipped: captured ? (capturedResults.numPendingTests ?? ((counts.skipped ?? 0) + (counts.pending ?? 0))) : null,
      plannedCases: totalPlannedCases,
      truncatedCases,
      cases,
      additionalTestsNotLinkedToScenarios: [],
    },
    coverage: {
      provider: coverageFeedback?.provider ?? null,
      reportPath: null,
      metrics: {
        statements: coverageMetric(totals?.statements),
        branches: coverageMetric(totals?.branches),
        functions: coverageMetric(totals?.functions),
        lines: coverageMetric(totals?.lines),
      },
      uncovered: [],
      notes: [],
    },
    artifacts: {
      junitXml: null,
      jestJson: null,
      coverageFinalJson: null,
      consoleLog: null,
      custom: [],
    },
    notes: [],
    issues: [],
    completion: {
      ready: true,
      completed: captured && counts['not-run'] === 0 && truncatedCases === 0,
      statusValues: [...EXECUTED_STATUSES],
      requiredBeforeAnalysis: ['execution.command', 'execution.environment.node', 'testResults.cases statuses', 'coverage.metrics when coverage was collected'],
    },
  };
  return assertAnalysisRunForm(form);
}

export { relativeArtifactPath };
