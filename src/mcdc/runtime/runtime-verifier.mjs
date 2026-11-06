export function normalizeRuntimeCollectionPath(value) {
  return String(value || '').replace(/\[(\d+)\]/g, '.$1').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
}

export function verifyRuntimeMcdcSide(runtimeRecords, cases, caseId, pair, side, inputCheck) {
  const testCase = cases.find(item => item.id === caseId);
  const reference = testCase?.references?.find(item => item.pairId === pair.pairId && item.side === side && item.mcdcAssertion);
  if (!reference) return { status: 'runtime-reference-not-found' };
  const assertion = reference.mcdcAssertion;
  let candidates = (runtimeRecords ?? []).filter(item => item.caseId === caseId &&
    item.decisionId === pair.decisionId && item.executionStatus === 'completed');
  if (assertion.callbackContext) {
    const expected = assertion.callbackContext;
    candidates = candidates.filter(item => item.callbackContext &&
      item.callbackContext.method === expected.method &&
      normalizeRuntimeCollectionPath(item.callbackContext.collection) === normalizeRuntimeCollectionPath(expected.collection) &&
      (!Number.isInteger(expected.iterationIndex) || item.callbackContext.iterationIndex === expected.iterationIndex));
  } else {
    candidates = candidates.filter(item => !item.callbackContext);
  }
  if (!candidates.length) return {
    status: assertion.callbackContext ? 'callback-decision-not-observed' : 'decision-not-observed',
    expectedDecisionOutcome: Boolean(assertion.expectedDecisionOutcome),
    expectedCallbackContext: assertion.callbackContext ?? null,
  };

  const expectedConditions = assertion.expectedAtomicConditionValues ?? {};
  const targetConditionId = pair.conditionId;
  const ranked = candidates.map(candidate => {
    const observed = Object.keys(expectedConditions).filter(id => candidate.conditions?.[id]?.evaluated);
    const matches = observed.filter(id => candidate.conditions[id].value === Boolean(expectedConditions[id]));
    return { candidate, observed: observed.length, matches: matches.length };
  }).sort((left, right) => right.matches - left.matches || right.observed - left.observed);
  const trace = ranked[0].candidate;
  if (trace.decisionOutcome !== Boolean(assertion.expectedDecisionOutcome)) {
    return { status: 'runtime-decision-mismatch', actualDecisionOutcome: trace.decisionOutcome,
      expectedDecisionOutcome: Boolean(assertion.expectedDecisionOutcome), trace };
  }

  const missingConditions = [];
  const inferredConditions = [];
  const mismatchedConditions = [];
  for (const [conditionId, expectedValue] of Object.entries(expectedConditions)) {
    const observed = trace.conditions?.[conditionId];
    if (!observed?.evaluated) {
      missingConditions.push(conditionId);
      if (conditionId !== targetConditionId &&
          ['verified', 'callback-runtime-context-verified'].includes(inputCheck?.status)) inferredConditions.push(conditionId);
      continue;
    }
    if (observed.value !== Boolean(expectedValue)) mismatchedConditions.push(conditionId);
  }

  if (mismatchedConditions.length) return {
    status: 'runtime-condition-mismatch', trace,
    mismatchedConditions,
    expectedConditions,
    actualConditions: Object.fromEntries(Object.entries(trace.conditions ?? {}).map(([id, item]) => [id, item.value])),
  };
  if (missingConditions.includes(targetConditionId)) return {
    status: 'target-condition-not-observed', trace, missingConditions,
    reason: 'The condition whose independent effect is being measured was not evaluated during this decision execution.',
  };
  const unresolved = missingConditions.filter(id => !inferredConditions.includes(id));
  if (unresolved.length) return { status: 'runtime-conditions-incomplete', trace, missingConditions, unresolvedConditions: unresolved };
  return {
    status: inferredConditions.length ? 'runtime-verified-with-short-circuit-inference' : 'runtime-instrumented-verified',
    trace,
    decisionOutcome: trace.decisionOutcome,
    targetConditionId,
    actualConditions: Object.fromEntries(Object.entries(trace.conditions ?? {}).map(([id, item]) => [id, item.value])),
    shortCircuitedConditions: missingConditions,
    inferredFromVerifiedConcreteInputs: inferredConditions,
    callbackContext: trace.callbackContext ?? null,
  };
}

