import { assertGenerationReport } from './report-schema.mjs';

/** Pure report-envelope composition; no filesystem, process, compiler or analyzer dependencies. */
export function createReportBuilder() {
  function build(input) {
    const report = {
      generator: { name: input.generatorName ?? 'branch-scenarios-generator', version: input.version },
      source: input.source,
      sourceLanguage: input.sourceLanguage,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      limitations: [...(input.limitations ?? [])],
      functions: [...(input.functions ?? [])],
    };

    if (input.constraintDiagnostics) {
      report.constraintEngine = aggregateConstraintStats(input.functionResults ?? [], input.constraintEngine ?? 'hybrid');
    }
    return assertGenerationReport(report);
  }
  return Object.freeze({ build });
}

function aggregateConstraintStats(functionResults, mode) {
  return functionResults.reduce((total, item) => {
    const stats = item._constraintStats ?? {};
    total.irAttempts += stats.irAttempts ?? 0;
    total.irSolved += stats.irSolved ?? 0;
    total.irSolutionCount += stats.irSolutionCount ?? 0;
    total.irTruncated += stats.irTruncated ?? 0;
    total.mcdcIrSolved += stats.mcdcIrSolved ?? 0;
    total.legacyFallback += stats.legacyFallback ?? 0;
    for (const [reason, count] of Object.entries(stats.fallbackReasons ?? {})) {
      total.fallbackReasons[reason] = (total.fallbackReasons[reason] ?? 0) + count;
    }
    return total;
  }, { mode, irAttempts: 0, irSolved: 0, irSolutionCount: 0, irTruncated: 0, mcdcIrSolved: 0, legacyFallback: 0, fallbackReasons: {} });
}
