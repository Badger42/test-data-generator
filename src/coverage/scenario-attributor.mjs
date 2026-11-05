/** Attribute runtime decision records and verified MC/DC sides to individual cases. */
export function buildScenarioCoverageAttribution(cases, testResults, runtimeRecords, functionResults, pairExecution) {
  const runtimeDecisionToBranch = new Map();
  for (const fn of functionResults ?? []) {
    for (const scenario of fn.scenarios ?? []) {
      const decisionId = scenario.target?.runtimeDecisionId;
      const branchId = scenario.target?.branchId;
      if (decisionId && branchId) {
        const current = runtimeDecisionToBranch.get(decisionId) ?? new Set();
        current.add(branchId);
        runtimeDecisionToBranch.set(decisionId, current);
      }
    }
  }

  const statusByCase = new Map((testResults?.cases ?? []).map(item => [item.id, item.status]));
  const caseMap = new Map((cases ?? []).map(item => [item.id, {
    caseId: item.id,
    testName: item.testName,
    status: statusByCase.get(item.id) ?? 'missing-result',
    arguments: item.arguments,
    mocks: item.mocks ?? [],
    references: item.references ?? [],
    decisionExecutions: [],
    coveredBranchOutcomes: [],
    mcdcPairSides: [],
  }]));

  for (const trace of runtimeRecords ?? []) {
    const caseEntry = caseMap.get(trace.caseId);
    if (!caseEntry || trace.executionStatus !== 'completed') continue;
    const branchIds = runtimeDecisionToBranch.get(trace.decisionId) ?? new Set();
    const execution = {
      decisionId: trace.decisionId,
      decisionOutcome: trace.decisionOutcome,
      callbackContext: trace.callbackContext ?? null,
      conditions: Object.fromEntries(Object.entries(trace.conditions ?? {}).map(([id, value]) => [id, {
        evaluated: Boolean(value?.evaluated),
        ...(value?.evaluated ? { value: Boolean(value.value) } : {}),
      }])),
    };
    caseEntry.decisionExecutions.push(execution);
    for (const branchId of branchIds) {
      const outcomeKey = JSON.stringify(trace.decisionOutcome);
      const existing = caseEntry.coveredBranchOutcomes.find(item => item.branchId === branchId && JSON.stringify(item.outcome) === outcomeKey);
      if (existing) existing.executionCount += 1;
      else caseEntry.coveredBranchOutcomes.push({
        branchId,
        outcome: trace.decisionOutcome,
        executionCount: 1,
        decisionIds: [trace.decisionId],
        callbackContexts: trace.callbackContext ? [trace.callbackContext] : [],
      });
    }
  }

  for (const pair of pairExecution ?? []) {
    const status = pair.status;
    const verified = ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(status);
    for (const side of ['conditionFalse', 'conditionTrue']) {
      const caseId = side === 'conditionFalse' ? pair.conditionFalseCaseId : pair.conditionTrueCaseId;
      const caseEntry = caseMap.get(caseId);
      if (!caseEntry) continue;
      caseEntry.mcdcPairSides.push({
        pairId: pair.pairId,
        decisionId: pair.decisionId,
        conditionId: pair.conditionId,
        side,
        verified,
        pairStatus: status,
      });
    }
  }

  const casesWithBranchAttribution = [...caseMap.values()].filter(item => item.coveredBranchOutcomes.length > 0).length;
  return {
    version: 1,
    method: 'runtime-decision-traces',
    totalCases: caseMap.size,
    passedCases: [...caseMap.values()].filter(item => item.status === 'passed').length,
    casesWithBranchAttribution,
    cases: [...caseMap.values()],
    notes: [
      'A branch outcome is attributed to a case only when a matching source-level runtime decision trace was recorded during that case.',
      'Istanbul counters remain aggregated for the complete Jest run; this attribution is based on scenario-tagged runtime decision traces, not isolated Istanbul counters.',
      'Targets without an instrumented runtimeDecisionId (for example switch dispatch in this release) cannot receive runtime attribution.',
    ],
  };
}
