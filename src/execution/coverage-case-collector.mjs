/**
 * Converts the stable scenario mock description into the runtime adapter payload.
 * External call-site descriptions are promoted to executable row mocks only when
 * a concrete target descriptor is available.
 */
function collectScenarioMocks(scenario) {
  const mocks = new Map();
  for (const mock of scenario.mocks ?? []) {
    const key = mock.callSiteId ?? mock.mockTarget?.id ?? mock.callId ?? mock.call;
    mocks.set(key, { ...mock });
  }
  for (const call of scenario.externalCalls ?? []) {
    if (!call.mockTarget) continue;
    const key = call.callSiteId ?? call.mockTarget.id;
    const current = mocks.get(key) ?? {
      callId: call.callId ?? call.mockTarget.id,
      callExpression: call.call ?? call.callExpression ?? 'unknown-call',
      callSiteId: call.callSiteId,
      mockTarget: call.mockTarget,
      behavior: call.mock?.behavior ?? 'mockReturnValue',
      ...(Object.prototype.hasOwnProperty.call(call.mock ?? {}, 'value') ? { value: call.mock.value } : {}),
    };
    mocks.set(key, {
      ...current,
      mockTarget: call.mockTarget,
      callArguments: call.callArguments ?? current.callArguments ?? [],
    });
  }
  return [...mocks.values()];
}

/** Deduplicates runnable branch and MC/DC scenarios into Jest execution cases. */
function collectCoverageExecutionCases(functionResults) {
  const byFingerprint = new Map();
  const pairRecords = [];

  function addCase(scenario, reference) {
    if (!scenario || !Array.isArray(scenario.arguments)) return null;
    if (scenario.unsupported?.length) return null;
    const expectedException = scenario.expectedException ?? reference?.expectedException ?? null;
    const payload = {
      arguments: scenario.arguments,
      mocks: collectScenarioMocks(scenario),
      expectedException,
    };
    const fingerprint = JSON.stringify(payload);
    let item = byFingerprint.get(fingerprint);
    if (!item) {
      item = {
        id: `coverage-case-${byFingerprint.size + 1}`,
        arguments: scenario.arguments,
        mocks: collectScenarioMocks(scenario),
        ...(expectedException ? { expectedException } : {}),
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
        ...(scenario.expectedException ? { expectedException: scenario.expectedException } : {}),
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
