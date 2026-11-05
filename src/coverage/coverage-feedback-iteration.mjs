/** Pure operations used by bounded coverage-feedback expansion. */
function staticOutcomeKey(branchId, outcome) {
  return `${branchId}:${JSON.stringify(outcome)}`;
}

export function collectUncoveredStaticOutcomeKeys(feedback) {
  const keys = new Set();
  for (const target of feedback?.staticBranchTargets ?? []) {
    const outcomes = target.outcomes ?? [];
    if (!outcomes.length || target.coverageStatus === 'covered' || target.coverageStatus === 'ambiguous' || target.coverageStatus === 'not-applicable') continue;

    if (target.coverageStatus === 'not-mapped' || target.coverageStatus === 'uncovered') {
      for (const outcome of outcomes) keys.add(staticOutcomeKey(target.id, outcome.value));
      continue;
    }

    for (const outcome of outcomes) {
      let index = Number.isInteger(outcome.coverageOutcomeIndex) ? outcome.coverageOutcomeIndex : null;
      if (index == null && typeof outcome.value === 'boolean' && ['if', 'cond-expr', 'while', 'for'].includes(target.coverageType)) {
        index = outcome.value ? 0 : 1;
      }
      if (index != null) {
        if (!target.coverageOutcomes?.[index]?.covered) keys.add(staticOutcomeKey(target.id, outcome.value));
      } else if (target.kind === 'switch') {
        if (outcome.covered !== true) keys.add(staticOutcomeKey(target.id, outcome.value));
      } else {
        // Unknown mapping semantics: conservatively retain the candidate rather
        // than claiming an outcome is covered from an unrelated counter.
        keys.add(staticOutcomeKey(target.id, outcome.value));
      }
    }
  }
  return keys;
}

function scenarioFeedbackFingerprint(scenario) {
  return JSON.stringify({
    branchId: scenario.target?.branchId ?? null,
    outcome: scenario.target?.outcome ?? null,
    label: scenario.target?.label ?? null,
    iterationIndex: scenario.target?.iterationIndex ?? null,
    arguments: scenario.arguments ?? [],
    mocks: scenario.mocks ?? [],
  });
}

export function mergeExpandedFunctionAnalysis(previous, expanded, missingOutcomeKeys, iteration) {
  const scenarios = [...(previous.scenarios ?? [])];
  const seen = new Set(scenarios.map(scenarioFeedbackFingerprint));
  const ids = new Set(scenarios.map(scenario => scenario.id));
  let added = 0;

  for (const scenario of expanded.scenarios ?? []) {
    const branchId = scenario.target?.branchId;
    const outcome = scenario.target?.outcome;
    if (!branchId || !missingOutcomeKeys.has(staticOutcomeKey(branchId, outcome))) continue;
    const fingerprint = scenarioFeedbackFingerprint(scenario);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    let candidate = { ...scenario };
    if (ids.has(candidate.id)) candidate.id = `${candidate.id}-feedback-${iteration}`;
    ids.add(candidate.id);
    candidate.feedbackIteration = iteration;
    scenarios.push(candidate);
    added += 1;
  }

  return {
    ...expanded,
    scenarios,
    summary: {
      ...expanded.summary,
      scenariosGenerated: scenarios.length,
      feedbackScenariosAdded: added,
    },
    unsupportedBranches: expanded.unsupportedBranches ?? previous.unsupportedBranches ?? [],
    feedbackScenariosAdded: added,
  };
}

export function summarizeCoverageIteration(feedback, iteration, generatedScenarioCount, addedScenarioCount) {
  return {
    iteration,
    status: feedback?.status ?? 'unknown',
    generatedScenarioCount,
    addedScenarioCount,
    executedScenarioCount: feedback?.execution?.generatedCases ?? feedback?.executedScenarioCount ?? null,
    jestTests: feedback?.execution?.testResults ? {
      total: feedback.execution.testResults.numTotalTests,
      passed: feedback.execution.testResults.numPassedTests,
      failed: feedback.execution.testResults.numFailedTests,
    } : feedback?.testResults ?? null,
    branchCoverage: feedback?.totals?.branches ?? null,
    staticTargets: feedback?.branchCoverage ? {
      covered: feedback.branchCoverage.staticTargetsCovered,
      partiallyCovered: feedback.branchCoverage.staticTargetsPartiallyCovered,
      uncovered: feedback.branchCoverage.staticTargetsUncovered,
      unmapped: feedback.branchCoverage.staticTargetsUnmapped,
    } : null,
  };
}
