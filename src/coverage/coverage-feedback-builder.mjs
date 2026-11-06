/** Compose normalized Istanbul counters and static branch mapping into feedback DTOs. */

function deriveLineCounters(fileCoverage) {
  const lineCounts = new Map();
  for (const [statementId, location] of Object.entries(fileCoverage.statementMap ?? {})) {
    const line = location?.start?.line;
    if (!Number.isInteger(line)) continue;
    const count = Number(fileCoverage.s?.[statementId] ?? 0);
    lineCounts.set(line, Math.max(lineCounts.get(line) ?? 0, count));
  }
  return Object.fromEntries([...lineCounts].map(([line, count]) => [line, count]));
}

export function createCoverageFeedbackBuilder({ path, summarizeCounterMap, normalizeCoverageFileMap, mapCoverageBranches, collectStaticBranchTargets }) {
function buildCoverageFeedback(coverageMap, sourceFile, functionResults, options = {}) {
  const match = normalizeCoverageFileMap(coverageMap, sourceFile);
  const staticTargets = collectStaticBranchTargets(functionResults);
  const mcdcPairs = functionResults.reduce((total, fn) => total + (fn.mcdc?.decisions ?? []).reduce(
    (decisionTotal, decision) => decisionTotal + (decision.conditions ?? []).reduce(
      (conditionTotal, condition) => conditionTotal + (condition.independencePairs?.length ?? 0), 0), 0), 0);
  if (!match) {
    return {
      version: 1,
      status: 'coverage-file-not-found',
      runner: options.runner ?? 'external-coverage',
      sourceFile: path.resolve(sourceFile),
      executedScenarioCount: options.executedScenarioCount ?? null,
      mcdc: {
        generatedIndependencePairs: mcdcPairs,
        inputPairVerification: 'unknown',
        note: 'Jest coverage does not itself measure atomic-condition independence. MC/DC pairs must be executed separately; this report only records their generated count.',
      },
      error: `No coverage entry matched the exact source path ${path.resolve(sourceFile)}. Check collectCoverageFrom and coveragePathIgnorePatterns.`,
    };
  }

  const fileCoverage = match.fileCoverage;
  const statements = summarizeCounterMap(fileCoverage.s);
  const functions = summarizeCounterMap(fileCoverage.f);
  const branches = summarizeCounterMap(fileCoverage.b);
  const lines = summarizeCounterMap(fileCoverage.l && Object.keys(fileCoverage.l).length ? fileCoverage.l : deriveLineCounters(fileCoverage));
  const mapped = mapCoverageBranches(fileCoverage, functionResults);
  const uncoveredBranchEntries = mapped.coverageEntries.filter(entry => entry.counts.some(count => Number(count) === 0));
  const coveredStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'covered');
  const partiallyCoveredStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'partially-covered');
  const uncoveredStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'uncovered');
  const unmappedStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'not-mapped');
  const ambiguousStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'ambiguous');
  const notApplicableStaticTargets = mapped.targets.filter(target => target.coverageStatus === 'not-applicable');

  return {
    version: 1,
    status: options.status ?? 'coverage-loaded',
    runner: options.runner ?? 'external-coverage',
    provider: options.provider ?? 'unknown',
    sourceFile: match.fileName,
    sourceFileMatch: match.matchedBy ?? 'absolute-path',
    executedScenarioCount: options.executedScenarioCount ?? null,
    testResults: options.testResults ?? null,
    totals: { statements, functions, branches, lines },
    branchCoverage: {
      allFileBranchesCovered: branches.total > 0 ? branches.covered === branches.total : null,
      staticTargetsCovered: coveredStaticTargets.length,
      staticTargetsPartiallyCovered: partiallyCoveredStaticTargets.length,
      staticTargetsUncovered: uncoveredStaticTargets.length,
      staticTargetsUnmapped: unmappedStaticTargets.length,
      staticTargetsAmbiguous: ambiguousStaticTargets.length,
      staticTargetsNotApplicable: notApplicableStaticTargets.length,
    },
    staticBranchTargets: mapped.targets,
    coverageBranchEntries: mapped.coverageEntries,
    uncoveredBranchEntries: uncoveredBranchEntries.map(entry => ({
      id: entry.id, type: entry.type, location: entry.loc,
      counters: entry.counts,
    })),
    mcdc: {
      generatedIndependencePairs: mcdcPairs,
      inputPairVerification: options.inputPairVerification ?? 'not-verified',
      note: 'Istanbul branch counters do not prove unique-cause MC/DC. With --mcdc --coverage-feedback, the target source is copied to a temporary sibling and instrumented at each analyzed decision and atomic-condition expression. The runtime recorder captures evaluated atom values and actual decision outcomes. Short-circuited fixed conditions may be inferred from the separately verified concrete input model and are explicitly distinguished from fully observed atoms. The target condition must be observed on both sides of a pair.',
    },
    notes: [
      'Coverage is aggregated across all generated scenarios, not isolated per scenario.',
      'Static branch-to-Istanbul mapping uses source line, branch kind and source start column. Ambiguous or distant matches are reported as ambiguous/not-mapped instead of silently selecting a potentially wrong entry. Switch outcomes share one Istanbul switch entry and are mapped by clause index.',
      'Array callback predicates may be represented as binary-expression coverage entries rather than regular if branches.',
    ],
  };
}

  return { buildCoverageFeedback };
}
