export const RUNTIME_MCDC_SYMBOL = 'branch-scenarios-generator.runtime-mcdc.v1';

const RECORDER_SOURCE = String.raw`
const AsyncLocalStorage = require('node:async_hooks').AsyncLocalStorage;
const RUNTIME_MCDC_SYMBOL = 'branch-scenarios-generator.runtime-mcdc.v1';
const runtimeCallbackStorage = new AsyncLocalStorage();
// Each instrumented decision owns an async-local frame stack. A shared stack
// corrupts evidence when two async callbacks evaluate the same decision in parallel.
const decisionFrameStorage = new AsyncLocalStorage();
function createMcdcRuntimeRecorder() {
  return {
    caseId: null,
    pendingAtoms: new Map(),
    records: [],
    callbackInvocation: 0,
    beginCase(caseId) {
      this.caseId = caseId;
      this.pendingAtoms.clear();
      this.callbackInvocation = 0;
    },
    getCallbackContext() {
      return runtimeCallbackStorage.getStore() ?? null;
    },
    runInCallback(context, callback) {
      const invocationId = ++this.callbackInvocation;
      return runtimeCallbackStorage.run({ ...context, caseId: this.caseId, invocationId }, callback);
    },
    // Backward-compatible synchronous scope API used by callers that cannot
    // supply a callback thunk. New instrumentation should prefer runInCallback.
    enterCallback(context) {
      const previous = this.getCallbackContext();
      const invocationId = ++this.callbackInvocation;
      runtimeCallbackStorage.enterWith({ ...context, caseId: this.caseId, invocationId });
      return previous;
    },
    leaveCallback(previous) {
      runtimeCallbackStorage.enterWith(previous ?? undefined);
    },
    recordConditionValue(decisionId, conditionId, rawValue) {
      const callbackContext = this.getCallbackContext();
      const caseId = callbackContext?.caseId ?? this.caseId;
      // Detached async callbacks may outlive their Jest case. Never attribute
      // their late completions to the next generated scenario.
      if (caseId !== this.caseId) return rawValue;
      const entry = {
        caseId,
        value: Boolean(rawValue),
        evaluated: true,
        callbackInvocationId: callbackContext?.invocationId ?? null,
        callbackContext: callbackContext ? { ...callbackContext } : null,
      };
      const frames = decisionFrameStorage.getStore() ?? [];
      const frame = [...frames].reverse().find(item => item.decisionId === decisionId &&
        item.caseId === caseId && item.callbackInvocationId === entry.callbackInvocationId);
      if (frame) frame.conditions[conditionId] = entry;
      else {
        const pending = this.pendingAtoms.get(decisionId) ?? [];
        pending.push({ conditionId, ...entry });
        this.pendingAtoms.set(decisionId, pending);
      }
      return rawValue;
    },
    condition(decisionId, conditionId, evaluate) { return this.recordConditionValue(decisionId, conditionId, evaluate()); },
    async conditionAsync(decisionId, conditionId, evaluate) { return this.recordConditionValue(decisionId, conditionId, await evaluate()); },
    takePending(decisionId) {
      const callbackContext = this.getCallbackContext();
      const caseId = callbackContext?.caseId ?? this.caseId;
      const invocationId = callbackContext?.invocationId ?? null;
      const pending = this.pendingAtoms.get(decisionId) ?? [];
      const selected = pending.filter(item => item.caseId === caseId && item.callbackInvocationId === invocationId);
      const remaining = pending.filter(item => item.caseId !== caseId || item.callbackInvocationId !== invocationId);
      if (remaining.length) this.pendingAtoms.set(decisionId, remaining);
      else this.pendingAtoms.delete(decisionId);
      return Object.fromEntries(selected.map(item => [item.conditionId, {
        value: item.value, evaluated: item.evaluated, callbackContext: item.callbackContext,
      }]));
    },
    decision(decisionId, evaluate) { return this.runDecision(decisionId, evaluate); },
    async decisionAsync(decisionId, evaluate) { return this.runDecisionAsync(decisionId, evaluate); },
    runDecision(decisionId, evaluate) {
      const callbackContext = this.getCallbackContext();
      const caseId = callbackContext?.caseId ?? this.caseId;
      if (caseId !== this.caseId) return evaluate();
      const frame = {
        decisionId, caseId,
        callbackInvocationId: callbackContext?.invocationId ?? null,
        callbackContext: callbackContext ? { ...callbackContext } : null,
        conditions: this.takePending(decisionId),
      };
      const parentFrames = decisionFrameStorage.getStore() ?? [];
      return decisionFrameStorage.run([...parentFrames, frame], () => {
        try {
          const rawValue = evaluate();
          this.records.push({ caseId: frame.caseId, decisionId, decisionOutcome: Boolean(rawValue),
            conditions: frame.conditions, callbackContext: frame.callbackContext, executionStatus: 'completed' });
          return rawValue;
        } catch (error) {
          this.records.push({ caseId: frame.caseId, decisionId, decisionOutcome: null,
            conditions: frame.conditions, callbackContext: frame.callbackContext, executionStatus: 'threw', error: error?.message ?? String(error) });
          throw error;
        }
      });
    },
    async runDecisionAsync(decisionId, evaluate) {
      const callbackContext = this.getCallbackContext();
      const caseId = callbackContext?.caseId ?? this.caseId;
      if (caseId !== this.caseId) return evaluate();
      const frame = {
        decisionId, caseId,
        callbackInvocationId: callbackContext?.invocationId ?? null,
        callbackContext: callbackContext ? { ...callbackContext } : null,
        conditions: this.takePending(decisionId),
      };
      const parentFrames = decisionFrameStorage.getStore() ?? [];
      return decisionFrameStorage.run([...parentFrames, frame], async () => {
        try {
          const rawValue = await evaluate();
          this.records.push({ caseId: frame.caseId, decisionId, decisionOutcome: Boolean(rawValue),
            conditions: frame.conditions, callbackContext: frame.callbackContext, executionStatus: 'completed' });
          return rawValue;
        } catch (error) {
          this.records.push({ caseId: frame.caseId, decisionId, decisionOutcome: null,
            conditions: frame.conditions, callbackContext: frame.callbackContext, executionStatus: 'threw', error: error?.message ?? String(error) });
          throw error;
        }
      });
    },
    snapshot() { return this.records; },
  };
}

globalThis.__BRANCH_SCENARIO_MCDC_INPUT_CHECKS__ = [];
globalThis[Symbol.for(RUNTIME_MCDC_SYMBOL)] = createMcdcRuntimeRecorder();
`;

export function createMcdcRuntimeRecorderSource() {
  return RECORDER_SOURCE;
}
