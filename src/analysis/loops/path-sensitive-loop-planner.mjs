function cloneState(state) { return new Map(state instanceof Map ? state : Object.entries(state ?? {})); }
function stateKey(state) { return JSON.stringify([...state.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))); }

/**
 * Bounded path-sensitive loop driver. The caller supplies symbolic condition
 * solving and a conservative abstract transfer. This is not concrete execution:
 * it explores only states represented by the supplied transfer function.
 */
export function planPathSensitiveLoop(input = {}) {
  if (typeof input.evaluate !== 'function' || typeof input.transfer !== 'function') {
    throw new TypeError('PathSensitiveLoopPlanner requires evaluate and transfer callbacks.');
  }
  const maxIterations = Math.max(1, Math.min(32, Number.isInteger(input.maxIterations) ? input.maxIterations : 8));
  const maxStates = Math.max(1, Math.min(256, Number.isInteger(input.maxStates) ? input.maxStates : 32));
  let state = cloneState(input.initialState);
  const seen = new Set();
  const iterations = [];
  const exitSolutions = [];
  const diagnostics = [];
  let terminated = false;
  let repeatedState = false;

  for (let iteration = 0; iteration < maxIterations && iterations.length < maxStates; iteration += 1) {
    const key = stateKey(state);
    if (seen.has(key)) {
      repeatedState = true;
      diagnostics.push({ code: 'LOOP_ABSTRACT_STATE_REPEATED', severity: 'info', iteration,
        message: 'Loop abstract state repeated; fixed-point exploration stopped.' });
      break;
    }
    seen.add(key);
    const evaluated = input.evaluate(cloneState(state), iteration) ?? {};
    const continueSolutions = evaluated.continueSolutions ?? [];
    const currentExitSolutions = evaluated.exitSolutions ?? [];
    if (currentExitSolutions.length) exitSolutions.push(...currentExitSolutions);
    iterations.push({
      iteration,
      state: Object.fromEntries(state),
      continueSolutions,
      exitSolutions: currentExitSolutions,
      reachable: continueSolutions.length > 0 || currentExitSolutions.length > 0,
    });
    if (!continueSolutions.length) {
      terminated = currentExitSolutions.length > 0;
      break;
    }
    const next = cloneState(input.transfer(cloneState(state), iteration));
    if (stateKey(next) === key) {
      repeatedState = true;
      diagnostics.push({ code: 'LOOP_TRANSFER_NO_PROGRESS', severity: 'warning', iteration,
        message: 'The abstract transfer did not change the loop state; further unrolling would repeat the same path.' });
      break;
    }
    state = next;
  }

  const truncated = !terminated && !repeatedState && iterations.length >= Math.min(maxIterations, maxStates);
  if (truncated) diagnostics.push({ code: 'LOOP_UNROLLING_LIMIT', severity: 'warning',
    message: `Path-sensitive loop exploration reached its bound (${iterations.length} iterations).` });
  return Object.freeze({
    schemaVersion: '1.0', algorithm: 'bounded-path-sensitive-loop-state-exploration',
    iterations: Object.freeze(iterations.map(item => Object.freeze({ ...item, state: Object.freeze(item.state) }))),
    exitSolutions: Object.freeze(exitSolutions),
    iterationCount: iterations.length,
    terminated, fixedPoint: repeatedState, truncated,
    diagnostics: Object.freeze(diagnostics),
    limits: Object.freeze({ maxIterations, maxStates, transfer: 'caller-supplied-conservative-abstract-transfer', runtimeExecution: false }),
  });
}
