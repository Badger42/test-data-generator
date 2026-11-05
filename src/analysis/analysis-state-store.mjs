import { createInitialFunctionAnalysisState, reduceFunctionAnalysisState } from './analysis-state-reducer.mjs';

function clone(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(clone(item, seen));
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = clone(item, seen);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

/** Session-owned append/reduce port. Events and snapshots are isolated per session. */
export function createFunctionAnalysisStateStore({ initialState } = {}) {
  let state = initialState ? clone(initialState) : createInitialFunctionAnalysisState();
  const dispatch = event => {
    // Events cross the producer/session boundary; detach payloads so a producer
    // cannot mutate already-recorded state after dispatch.
    state = reduceFunctionAnalysisState(state, clone(event));
    return state.eventCount;
  };
  const snapshot = () => deepFreeze(clone(state));
  const port = Object.freeze({ dispatch, snapshot });
  return Object.freeze({ dispatch, snapshot, port });
}
