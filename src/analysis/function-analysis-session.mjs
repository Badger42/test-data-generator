/**
 * Owns one function-analysis lifecycle. Mutable state is private to this
 * session; consumers receive immutable result/snapshot objects.
 */
import { createFunctionAnalysisStateStore } from './analysis-state-store.mjs';

const TERMINAL = new Set(['completed', 'failed']);

function freezeSnapshot(state) {
  return Object.freeze({
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    eventCount: state.eventCount,
    diagnostics: Object.freeze([...state.diagnostics]),
    error: state.error,
  });
}

export class FunctionAnalysisSession {
  #environment;
  #adapter;
  #state;
  #result = null;
  #analysisState;
  #analysisPort;

  constructor(environment, adapter) {
    if (!environment?.functionUnit) throw new TypeError('FunctionAnalysisSession requires functionUnit.');
    if (!adapter || typeof adapter.analyze !== 'function') throw new TypeError('FunctionAnalysisSession requires an analyzer adapter.');

    this.#environment = Object.freeze({
      ...environment,
      limits: Object.freeze({ ...(environment.limits ?? {}) }),
      features: Object.freeze({ ...(environment.features ?? {}) }),
    });
    this.#adapter = adapter;
    this.#analysisState = createFunctionAnalysisStateStore();
    this.#state = {
      status: 'created',
      startedAt: null,
      completedAt: null,
      eventCount: 0,
      diagnostics: [],
      error: null,
    };
    this.#analysisPort = Object.freeze({
      dispatch: event => {
        if (this.#state.status !== 'running') {
          throw new Error(`Cannot dispatch analysis event '${event?.type ?? 'unknown'}' while session is '${this.#state.status}'.`);
        }
        return this.#analysisState.dispatch(event);
      },
      snapshot: () => this.#analysisState.snapshot(),
    });
  }

  get functionId() { return this.#environment.functionUnit.functionId; }

  get snapshot() { return freezeSnapshot(this.#state); }

  get result() { return this.#result; }

  get analysisSnapshot() { return this.#analysisState.snapshot(); }

  analyze() {
    if (this.#state.status !== 'created') {
      throw new Error(`Analysis session cannot run from state '${this.#state.status}'.`);
    }

    this.#dispatch({ type: 'started' });
    try {
      const result = this.#adapter.analyze({ ...this.#environment, analysisState: this.#analysisPort });
      if (!result || typeof result !== 'object') throw new TypeError('Analyzer adapter must return an analysis result object.');
      this.#result = deepFreeze(result);
      this.#dispatch({ type: 'completed' });
      return this.#result;
    } catch (error) {
      this.#dispatch({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  #dispatch(event) {
    if (TERMINAL.has(this.#state.status)) throw new Error(`Cannot dispatch '${event.type}' after session termination.`);
    this.#state.eventCount += 1;
    if (event.type === 'started') {
      this.#state.status = 'running';
      this.#state.startedAt = Date.now();
    } else if (event.type === 'completed') {
      this.#state.status = 'completed';
      this.#state.completedAt = Date.now();
    } else if (event.type === 'failed') {
      this.#state.status = 'failed';
      this.#state.completedAt = Date.now();
      this.#state.error = event.error;
    } else if (event.type === 'diagnostic') {
      this.#state.diagnostics.push(Object.freeze({ ...event.diagnostic }));
    } else {
      throw new Error(`Unknown analysis session event '${event.type}'.`);
    }
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map || value instanceof Set) return value;
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

export function createFunctionAnalysisSession(environment, adapter) {
  return new FunctionAnalysisSession(environment, adapter);
}
