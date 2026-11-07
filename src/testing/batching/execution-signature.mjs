const SUPPORTED_BEHAVIORS = new Set([
  'mockReturnValue', 'mockResolvedValue', 'mockRejectedValue',
  'mockImplementation', 'sequence', 'conditional',
]);
const LEAF_BEHAVIORS = new Set([
  'mockReturnValue', 'mockResolvedValue', 'mockRejectedValue', 'mockImplementation',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function mockIdentity(mock) {
  // Jest setup registries address mocks by method/call identity; source-site IDs
  // are a safe fallback only when the method identity is unavailable.
  const methodIdentity = mock?.mockTarget?.id ?? mock?.callId ?? mock?.callExpression ?? mock?.call;
  const rawIdentity = typeof methodIdentity === 'string' && methodIdentity.trim() && methodIdentity.trim() !== 'unknown-call'
    ? methodIdentity
    : mock?.callSiteId;
  return typeof rawIdentity === 'string' && rawIdentity.trim() && rawIdentity.trim() !== 'unknown-call'
    ? rawIdentity.trim() : null;
}

function executionProfile(testCase, context = {}) {
  return {
    target: String(testCase.functionId ?? context.functionId ?? testCase.functionName ?? context.functionName ?? 'default-target'),
    exportPath: String(testCase.exportPath ?? context.exportPath ?? ''),
    setupProfile: String(testCase.setupProfileId ?? context.setupProfileId ?? ''),
    environment: String(testCase.environmentSignature ?? context.environmentSignature ?? ''),
    lifecycle: String(testCase.lifecycle ?? context.lifecycle ?? 'isolated-test'),
    runtime: String(testCase.runtimeKind ?? context.runtimeKind ?? 'jest'),
  };
}

/**
 * Produces the execution shape used to decide whether cases can safely share
 * one Jest `test.each` declaration. Values/behaviors are intentionally omitted:
 * they are installed afresh for each row. The exact mocked method set
 * (falling back to call-site IDs only when necessary) and setup/runtime profile must match.
 */
export function createExecutionSignature(testCase, context = {}) {
  const mocks = Array.isArray(testCase?.mocks) ? testCase.mocks : [];
  const mockMethods = [...new Set(mocks.map(mockIdentity).filter(Boolean))].sort();
  const reasons = [];

  if (testCase?.requiresDedicatedTest === true || testCase?.requiresIsolation === true || testCase?.batching?.allowed === false) {
    reasons.push(testCase.batching?.reason ?? 'Scenario explicitly requires an isolated test declaration.');
  }
  if (testCase?.unsupported?.length) reasons.push('Scenario contains unsupported execution requirements.');
  for (const mock of mocks) {
    const identity = mockIdentity(mock);
    if (!identity) {
      reasons.push('A mock does not expose a stable call-site identity.');
    }
    const behavior = mock?.behavior ?? 'mockReturnValue';
    if (!SUPPORTED_BEHAVIORS.has(behavior)) {
      reasons.push(`Mock '${identity ?? 'unknown-call'}' uses unsupported batching behavior '${behavior}'.`);
    }
    if (behavior === 'sequence' && (mock.sequence ?? []).some(step => !LEAF_BEHAVIORS.has(step.behavior))) {
      reasons.push(`Mock '${identity ?? 'unknown-call'}' has an unsupported sequence step.`);
    }
    if (behavior === 'conditional' && [...(mock.cases ?? []).map(item => item.action), mock.defaultAction].filter(Boolean)
      .some(action => !LEAF_BEHAVIORS.has(action.behavior))) {
      reasons.push(`Mock '${identity ?? 'unknown-call'}' has an unsupported conditional action.`);
    }
  }

  const profile = executionProfile(testCase ?? {}, context);
  const signature = {
    version: 1,
    ...profile,
    mockMethods,
  };
  return Object.freeze({
    key: stableStringify(signature),
    signature: Object.freeze(signature),
    batchable: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export { mockIdentity, stableStringify };
