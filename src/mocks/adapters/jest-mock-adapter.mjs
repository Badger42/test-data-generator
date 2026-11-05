function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sameArgs(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

/** Applies a JSON-safe MockPlan to injected Jest mock functions; imports no Jest package. */
export function createJestMockAdapter(options = {}) {
  const handlers = options.handlers ?? new Map();
  const getHandler = id => handlers instanceof Map ? handlers.get(id) : handlers[id];

  function applyStep(mockFn, step) {
    switch (step.behavior) {
      case 'mockReturnValue': mockFn.mockReturnValue(step.value); break;
      case 'mockResolvedValue': mockFn.mockResolvedValue(step.value); break;
      case 'mockRejectedValue': mockFn.mockRejectedValue(step.error ?? step.value); break;
      case 'mockImplementation': {
        const implementation = getHandler(step.handlerId);
        if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${step.handlerId}' is not registered.`);
        mockFn.mockImplementation(implementation);
        break;
      }
      default: throw new TypeError(`Unsupported Jest mock behavior '${step.behavior}'.`);
    }
  }

  function apply(mockPlan, registry) {
    const applied = [];
    for (const action of mockPlan?.actions ?? []) {
      const mockFn = registry instanceof Map
        ? (registry.get(action.callId) ?? registry.get(action.callExpression))
        : (registry[action.callId] ?? registry[action.callExpression]);
      if (!mockFn) throw new Error(`No Jest mock registered for '${action.callExpression}'.`);

      if (action.behavior === 'sequence') {
        for (const step of action.sequence ?? []) {
          const method = `${step.behavior}Once`;
          if (typeof mockFn[method] !== 'function') throw new TypeError(`Jest mock does not implement ${method}().`);
          if (step.behavior === 'mockImplementation') {
            const implementation = getHandler(step.handlerId);
            if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${step.handlerId}' is not registered.`);
            mockFn.mockImplementationOnce(implementation);
          } else if (step.behavior === 'mockRejectedValue') mockFn.mockRejectedValueOnce(step.error ?? step.value);
          else mockFn[method](step.value);
        }
      } else if (action.behavior === 'conditional') {
        const cases = action.cases ?? [];
        const fallback = action.defaultAction;
        mockFn.mockImplementation((...args) => {
          const match = cases.find(item => item.when?.args && sameArgs(args, item.when.args));
          const selected = match?.action ?? fallback;
          if (!selected) throw new Error(`No conditional mock case matched '${action.callExpression}'.`);
          switch (selected.behavior) {
            case 'mockReturnValue': return selected.value;
            case 'mockResolvedValue': return Promise.resolve(selected.value);
            case 'mockRejectedValue': return Promise.reject(selected.error ?? selected.value);
            case 'mockImplementation': {
              const implementation = getHandler(selected.handlerId);
              if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${selected.handlerId}' is not registered.`);
              return implementation(...args);
            }
            default: throw new TypeError(`Unsupported conditional mock behavior '${selected.behavior}'.`);
          }
        });
      } else {
        applyStep(mockFn, action);
      }
      applied.push(action.callId);
    }
    return { applied };
  }



  return Object.freeze({ apply });
}
