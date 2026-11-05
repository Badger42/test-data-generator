/** Deduplicates runnable branch and MC/DC scenarios into Jest execution cases. */
function collectCoverageExecutionCases(functionResults) {
  const byFingerprint = new Map();
  const pairRecords = [];

  function addCase(scenario, reference) {
    if (!scenario || !Array.isArray(scenario.arguments)) return null;
    if (scenario.unsupported?.length) return null;
    const payload = {
      arguments: scenario.arguments,
      mocks: scenario.mocks ?? [],
    };
    const fingerprint = JSON.stringify(payload);
    let item = byFingerprint.get(fingerprint);
    if (!item) {
      item = {
        id: `coverage-case-${byFingerprint.size + 1}`,
        arguments: scenario.arguments,
        mocks: scenario.mocks ?? [],
        references: [],
      };
      byFingerprint.set(fingerprint, item);
    }
    if (reference) item.references.push(reference);
    return item.id;
  }

  for (const fn of functionResults) {
    for (const scenario of fn.scenarios ?? []) {
      addCase(scenario, {
        type: 'branch', functionName: fn.name, scenarioId: scenario.id,
        branchId: scenario.target?.branchId, outcome: scenario.target?.outcome,
      });
    }
    for (const decision of fn.mcdc?.decisions ?? []) {
      for (const condition of decision.conditions ?? []) {
        for (const pair of condition.independencePairs ?? []) {
          const makeMcdcReference = (scenario, side) => ({
            type: 'mcdc', functionName: fn.name, decisionId: decision.decisionId,
            conditionId: condition.id, pairId: pair.pairId, side,
            mcdcAssertion: {
              decisionExpression: decision.expression,
              conditions: (decision.conditions ?? []).map(item => ({ id: item.id, expression: item.expression })),
              expectedAtomicConditionValues: scenario.atomicConditionValues ?? {},
              expectedDecisionOutcome: scenario.decisionOutcome,
              callbackContext: scenario.callbackContext ?? decision.callbackContext ?? null,
              functionParameterNames: fn.parameters
                .map(parameter => parameter.supported && /^[A-Za-z_$][\w$]*$/.test(parameter.name) ? parameter.name : null),
            },
          });
          const falseId = addCase(pair.scenarios?.conditionFalse, makeMcdcReference(pair.scenarios?.conditionFalse, 'conditionFalse'));
          const trueId = addCase(pair.scenarios?.conditionTrue, makeMcdcReference(pair.scenarios?.conditionTrue, 'conditionTrue'));
          if (falseId && trueId) {
            pairRecords.push({
              functionName: fn.name,
              decisionId: decision.decisionId,
              conditionId: condition.id,
              pairId: pair.pairId,
              callbackContext: pair.scenarios?.conditionFalse?.callbackContext ?? decision.callbackContext ?? null,
              conditionFalseCaseId: falseId,
              conditionTrueCaseId: trueId,
            });
          }
        }
      }
    }
  }

  return {
    cases: [...byFingerprint.values()].map((item, index) => ({
      ...item,
      testName: `[Branch Scenario] ${String(index + 1).padStart(4, '0')} ${item.id}`,
    })),
    pairRecords,
  };
}

export { collectCoverageExecutionCases };
