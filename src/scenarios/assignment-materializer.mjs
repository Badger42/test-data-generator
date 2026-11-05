const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function defaultClone(value) {
  if (Array.isArray(value)) return value.map(defaultClone);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FORBIDDEN_SEGMENTS.has(key)) copy[key] = defaultClone(item);
    }
    return copy;
  }
  return value;
}

function normalizeAssignments(assignments) {
  if (assignments instanceof Map) return [...assignments.values()];
  if (Array.isArray(assignments)) return assignments;
  if (assignments && typeof assignments[Symbol.iterator] === 'function') return [...assignments];
  throw new TypeError('assignments must be a Map, array or iterable.');
}

function setNestedValue(target, path, value, options) {
  if (!path.length) return value;
  if (!target || typeof target !== 'object') return target;
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = String(path[index]);
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new TypeError(`Unsafe assignment path segment '${segment}'.`);
    const nextIsIndex = /^\d+$/.test(String(path[index + 1]));
    if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = nextIsIndex ? [] : {};
    cursor = cursor[segment];
  }
  const last = String(path[path.length - 1]);
  if (FORBIDDEN_SEGMENTS.has(last)) throw new TypeError(`Unsafe assignment path segment '${last}'.`);
  if (options.isUndefined(value)) delete cursor[last];
  else cursor[last] = options.clone(value);
  return target;
}

/**
 * Materializes solver assignments into function arguments and JSON-safe mock-root values.
 * It does not choose mock behavior or call Jest; MockPlanner owns those responsibilities.
 * Type defaults and solver interval constraints are supplied through narrow factories.
 */
export function createAssignmentMaterializer(options = {}) {
  const clone = options.cloneValue ?? defaultClone;
  const serialize = options.serializeValue ?? (value => value);
  const isUndefined = options.isUndefined ?? (value => value === undefined);
  const materializeLength = options.materializeLengthConstraint ?? (constraint => constraint.value);
  const materializeNumeric = options.materializeNumericConstraint ?? (constraint => constraint.value);

  function resolveAssignmentValue(assignment) {
    if (assignment.lengthConstraint) return materializeLength(assignment.lengthConstraint, assignment);
    if (assignment.numericConstraint) return materializeNumeric(assignment.numericConstraint, assignment);
    return assignment.value;
  }

  function materialize(input) {
    const args = clone(input.baseArguments ?? []);
    const mockValues = new Map();
    const parameterMap = input.parameterMap ?? new Map();
    const mockBindingMap = input.mockBindingMap ?? input.localMockMap ?? new Map();
    const assignments = normalizeAssignments(input.assignments);

    for (const assignment of assignments) {
      if (!assignment || !Array.isArray(assignment.path) || assignment.path.length === 0) {
        throw new TypeError('Every assignment must have a non-empty path.');
      }
      const path = assignment.path.map(String);
      if (path.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
        throw new TypeError('Assignment contains an unsafe path segment.');
      }
      const value = resolveAssignmentValue(assignment);
      const root = path[0];
      const parameter = parameterMap.get(root);

      if (parameter) {
        const index = parameter.index;
        if (path.length === 1) {
          args[index] = clone(value);
        } else {
          if (args[index] == null || isUndefined(args[index]) || args[index]?.$undefined === true || typeof args[index] !== 'object') {
            args[index] = clone(input.getParameterDefault?.(parameter, assignment) ?? {});
          }
          setNestedValue(args[index], path.slice(1), value, { clone, isUndefined });
        }
        continue;
      }

      const binding = mockBindingMap.get(root);
      if (!binding) continue;
      const mockKey = root;
      if (!mockValues.has(mockKey)) {
        const initialValue = input.getMockDefault?.(binding, assignment);
        mockValues.set(mockKey, {
          localName: root,
          // Strip compiler-side `resolvedType` and any AST/checker references at
          // the materialization boundary. MockPlanner receives plain metadata.
          binding: {
            localName: root,
            call: String(binding.call ?? binding.callExpression ?? binding.callId ?? 'unknown-call'),
            callId: String(binding.callId ?? binding.call ?? binding.callExpression ?? 'unknown-call'),
            callExpression: String(binding.callExpression ?? binding.call ?? binding.callId ?? 'unknown-call'),
            ...(binding.callSiteId ? { callSiteId: String(binding.callSiteId) } : {}),
            isPromise: Boolean(binding.isPromise),
            awaited: Boolean(binding.awaited),
            ...(binding.sourceSpan ? { sourceSpan: clone(binding.sourceSpan) } : {}),
          },
          value: clone(initialValue),
        });
      }
      const mock = mockValues.get(mockKey);
      if (path.length === 1) mock.value = clone(value);
      else {
        if (mock.value == null || isUndefined(mock.value) || mock.value?.$undefined === true || typeof mock.value !== 'object') {
          mock.value = clone(input.getMockDefault?.(binding, assignment) ?? {});
        }
        setNestedValue(mock.value, path.slice(1), value, { clone, isUndefined });
      }
    }

    return {
      arguments: serialize(args),
      mockAssignments: [...mockValues.values()].map(mock => ({
        localName: mock.localName,
        binding: mock.binding,
        value: serialize(mock.value),
      })),
    };
  }

  return Object.freeze({ materialize });
}
