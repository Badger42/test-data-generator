const STANDARD_BEHAVIORS = new Set([
  'mockReturnValue', 'mockResolvedValue', 'mockRejectedValue', 'mockImplementation',
]);

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]));
  }
  return value;
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') throw new TypeError('Mock sequence step must be an object.');
  const behavior = step.behavior;
  if (!STANDARD_BEHAVIORS.has(behavior)) throw new TypeError(`Unsupported mock behavior '${behavior}'.`);
  if (behavior === 'mockImplementation' && !step.handlerId) throw new TypeError('mockImplementation requires handlerId.');
  return {
    behavior,
    ...(Object.prototype.hasOwnProperty.call(step, 'value') ? { value: cloneJson(step.value) } : {}),
    ...(step.error ? { error: cloneJson(step.error) } : {}),
    ...(step.handlerId ? { handlerId: String(step.handlerId) } : {}),
  };
}

function deepMerge(target, source) {
  if (!target || typeof target !== 'object' || !source || typeof source !== 'object' || Array.isArray(target) || Array.isArray(source)) return cloneJson(source);
  const output = cloneJson(target);
  for (const [key, value] of Object.entries(source)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])
      ? deepMerge(output[key], value) : cloneJson(value);
  }
  return output;
}

/** Converts materialized mock-root values and optional behavior policies into a JSON-safe MockPlan. */
export function createMockStatePlanner() {
  function plan(input = {}) {
    const groups = new Map();
    for (const item of input.mockAssignments ?? []) {
      const binding = item.binding ?? input.bindings?.get?.(item.localName);
      if (!binding) continue;
      const callExpression = String(binding.callExpression ?? binding.call ?? binding.callId ?? 'unknown-call');
      const callId = String(binding.callId ?? callExpression);
      const key = callId;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          callId,
          callExpression,
          callSiteId: binding.callSiteId ?? null,
          behavior: binding.isPromise || binding.awaited ? 'mockResolvedValue' : 'mockReturnValue',
          value: cloneJson(item.value),
          evidence: [{ source: 'solver', status: 'candidate', ...(binding.sourceSpan ? { sourceSpan: binding.sourceSpan } : {}), message: `Mock result materialized for ${callExpression}.` }],
        });
      } else {
        existing.value = deepMerge(existing.value, item.value);
      }
    }

    const actions = [...groups.values()];
    const overrides = input.behaviorOverrides ?? {};
    for (const action of actions) {
      const override = overrides[action.callId] ?? overrides[action.callExpression];
      if (!override) continue;
      if (override.behavior === 'sequence') {
        if (!Array.isArray(override.sequence) || override.sequence.length === 0) throw new TypeError('Mock sequence must contain at least one step.');
        action.behavior = 'sequence';
        action.sequence = override.sequence.map(normalizeStep);
        delete action.value;
      } else if (override.behavior === 'conditional') {
        if (!Array.isArray(override.cases) || override.cases.length === 0) throw new TypeError('Conditional mock requires at least one case.');
        action.behavior = 'conditional';
        action.cases = override.cases.map(item => ({
          when: cloneJson(item.when ?? {}),
          action: normalizeStep(item.action),
        }));
        if (override.default) action.defaultAction = normalizeStep(override.default);
        delete action.value;
      } else {
        const normalized = normalizeStep(override);
        action.behavior = normalized.behavior;
        // A behavior-only override changes Jest semantics without discarding
        // the solver-materialized return value. An explicit `value` replaces
        // it; rejection/implementation modes do not retain a resolved value.
        if (Object.prototype.hasOwnProperty.call(normalized, 'value')) action.value = normalized.value;
        else if (normalized.behavior === 'mockRejectedValue' || normalized.behavior === 'mockImplementation') delete action.value;
        if (normalized.error) action.error = normalized.error;
        if (normalized.handlerId) action.handlerId = normalized.handlerId;
      }
    }
    return Object.freeze({ version: 1, actions, diagnostics: [] });
  }



  function toScenarioMocks(mockPlan) {
    return (mockPlan?.actions ?? []).map(action => ({
      callId: action.callId,
      callExpression: action.callExpression,
      ...(action.callSiteId ? { callSiteId: action.callSiteId } : {}),
      behavior: action.behavior,
      ...(Object.prototype.hasOwnProperty.call(action, 'value') ? { value: cloneJson(action.value) } : {}),
      ...(action.error ? { error: cloneJson(action.error) } : {}),
      ...(action.sequence ? { sequence: cloneJson(action.sequence) } : {}),
      ...(action.cases ? { cases: cloneJson(action.cases) } : {}),
      ...(action.defaultAction ? { defaultAction: cloneJson(action.defaultAction) } : {}),
      ...(action.handlerId ? { handlerId: action.handlerId } : {}),
      evidence: cloneJson(action.evidence ?? []),
    }));
  }

  return Object.freeze({ plan, toScenarioMocks });
}
