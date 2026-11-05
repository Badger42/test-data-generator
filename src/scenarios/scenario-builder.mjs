import { createScenarioFingerprint } from './scenario-fingerprint.mjs';

function toDomainMock(mock) {
  return {
    callId: String(mock.callId ?? mock.call ?? mock.callExpression ?? 'unknown-call'),
    callExpression: String(mock.callExpression ?? mock.call ?? mock.callId ?? 'unknown-call'),
    ...(mock.callSiteId ? { callSiteId: mock.callSiteId } : {}),
    behavior: mock.behavior ?? 'mockReturnValue',
    ...(Object.prototype.hasOwnProperty.call(mock, 'resolvedValue') ? { value: mock.resolvedValue } : Object.prototype.hasOwnProperty.call(mock, 'value') ? { value: mock.value } : {}),
    ...(mock.error ? { error: mock.error } : {}),
    ...(mock.sequence ? { sequence: mock.sequence } : {}),
    ...(mock.cases ? { cases: mock.cases } : {}),
    ...(mock.defaultAction ? { defaultAction: mock.defaultAction } : {}),
    ...(mock.handlerId ? { handlerId: mock.handlerId } : {}),
    ...(mock.inputDependencies ? { inputDependencies: mock.inputDependencies } : {}),
    ...(mock.dataFlowEffects ? { dataFlowEffects: mock.dataFlowEffects } : {}),
    ...(mock.contextIds ? { contextIds: mock.contextIds } : {}),
    evidence: mock.evidence ?? [{ source: 'solver', status: 'candidate', message: 'Mock value materialized from solver assignments.' }],
  };
}

export function createScenarioBuilder(options = {}) {
  const evidenceBuilder = options.evidenceBuilder;

  function build(input) {
    if (!input?.id || !input?.functionId) throw new TypeError('ScenarioBuilder requires id and functionId.');
    const argumentsValue = input.arguments ?? [];
    const mocks = (input.mocks ?? []).map(toDomainMock);
    const fingerprint = input.fingerprint ?? createScenarioFingerprint({ arguments: argumentsValue, mocks });
    const evidence = input.evidence ?? evidenceBuilder?.build({
      incoming: input.incoming,
      assignments: input.assignments,
      unsupported: input.unsupported,
      sourceSpan: input.sourceSpan,
      dataFlowModel: input.dataFlowModel,
      target: input.target,
    });
    const warnings = input.warnings ?? evidence?.warnings ?? [];
    const scenario = {
      id: input.id,
      functionId: input.functionId,
      arguments: argumentsValue,
      mocks,
      targets: input.targets ?? [],
      assumptions: input.assumptions ?? evidence?.assumptions ?? [],
      warnings,
      evidence: input.evidence ?? (Array.isArray(evidence) ? evidence : evidence?.evidence ?? []),
      fingerprint,
    };
    return Object.freeze(scenario);
  }



  return Object.freeze({ build });
}
