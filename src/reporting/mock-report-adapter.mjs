/**
 * Projects the domain MockPlan into the stable public JSON report representation.
 * The adapter owns report naming/shape; MockPlanner and Jest adapters stay domain/runtime focused.
 */
function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

export function createMockReportAdapter() {
  function project(mockPlan) {
    return (mockPlan?.actions ?? []).map(action => {
      const output = {
        call: action.callExpression,
        behavior: action.behavior,
      };
      if (Object.prototype.hasOwnProperty.call(action, 'value')) output.resolvedValue = cloneJson(action.value);
      if (action.error) output.error = cloneJson(action.error);
      if (action.sequence) output.sequence = cloneJson(action.sequence);
      if (action.cases) output.cases = cloneJson(action.cases);
      if (action.defaultAction) output.defaultAction = cloneJson(action.defaultAction);
      if (action.handlerId) output.handlerId = String(action.handlerId);
      if (action.inputDependencies?.length) output.inputDependencies = cloneJson(action.inputDependencies);
      if (action.dataFlowEffects?.length) output.dataFlowEffects = cloneJson(action.dataFlowEffects);
      if (action.contextIds?.length) output.contextIds = cloneJson(action.contextIds);
      return output;
    });
  }
  function hydrate(reportMocks = []) {
    return Object.freeze({
      version: 1,
      actions: reportMocks.map(mock => ({
        callId: String(mock.callId ?? mock.call ?? mock.callExpression ?? 'unknown-call'),
        callExpression: String(mock.callExpression ?? mock.call ?? mock.callId ?? 'unknown-call'),
        behavior: mock.behavior ?? 'mockReturnValue',
        ...(Object.prototype.hasOwnProperty.call(mock, 'resolvedValue') ? { value: cloneJson(mock.resolvedValue) } : Object.prototype.hasOwnProperty.call(mock, 'value') ? { value: cloneJson(mock.value) } : {}),
        ...(mock.error ? { error: cloneJson(mock.error) } : {}),
        ...(mock.sequence ? { sequence: cloneJson(mock.sequence) } : {}),
        ...(mock.cases ? { cases: cloneJson(mock.cases) } : {}),
        ...(mock.defaultAction ? { defaultAction: cloneJson(mock.defaultAction) } : {}),
        ...(mock.handlerId ? { handlerId: String(mock.handlerId) } : {}),
      })),
      diagnostics: [],
    });
  }

  return Object.freeze({ project, hydrate });
}
