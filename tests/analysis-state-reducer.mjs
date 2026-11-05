import assert from 'node:assert/strict';
import { createInitialFunctionAnalysisState, reduceFunctionAnalysisState } from '../src/analysis/analysis-state-reducer.mjs';
import { createFunctionAnalysisStateStore } from '../src/analysis/analysis-state-store.mjs';

const initial = createInitialFunctionAnalysisState();
const branch = reduceFunctionAnalysisState(initial, {
  type: 'analysis.branch-outcome-observed', key: 'if-1:true', branchId: 'if-1', outcome: true,
});
assert.equal(initial.branchCount, 0, 'the reducer must not mutate its input state');
assert.equal(branch.branchCount, 1);
assert.equal(reduceFunctionAnalysisState(branch, {
  type: 'analysis.branch-outcome-observed', key: 'if-1:true', branchId: 'if-1', outcome: true,
}).branchCount, 1, 'branch outcomes are unique by their stable key');

const unsupported = reduceFunctionAnalysisState(branch, {
  type: 'analysis.unsupported-branch-recorded',
  branch: { branchId: 'if-2', outcome: false, reason: 'unknown' },
});
const cleared = reduceFunctionAnalysisState(unsupported, {
  type: 'analysis.unsupported-branch-cleared', branchId: 'if-2', outcome: false,
});
assert.equal(cleared.unsupportedBranches.length, 0);

const storeA = createFunctionAnalysisStateStore();
const storeB = createFunctionAnalysisStateStore();
const recordedScenario = { id: 'A' };
storeA.dispatch({ type: 'analysis.scenario-added', scenario: recordedScenario });
recordedScenario.id = 'mutated-after-dispatch';
assert.equal(storeA.snapshot().scenarios[0].id, 'A', 'dispatch must detach mutable event payloads from producer-owned objects');
storeA.dispatch({ type: 'analysis.loop-entered' });
storeA.dispatch({ type: 'analysis.constraint-stat-incremented', key: 'irAttempts' });
storeA.dispatch({ type: 'analysis.constraint-fallback-recorded', reason: 'not-supported' });
assert.equal(storeA.snapshot().scenarios.length, 1);
assert.equal(storeA.snapshot().loopCount, 1);
assert.equal(storeA.snapshot().constraintStats.irAttempts, 1);
assert.equal(storeA.snapshot().constraintStats.legacyFallback, 1);
assert.equal(storeA.snapshot().constraintStats.fallbackReasons['not-supported'], 1);
assert.equal(storeB.snapshot().eventCount, 0, 'state stores must be isolated');
assert.ok(Object.isFrozen(storeA.snapshot()));
assert.ok(Object.isFrozen(storeA.snapshot().scenarios[0]));
assert.throws(() => storeA.dispatch({ type: 'analysis.unknown' }), /Unknown function analysis event/);
console.log('Analysis state reducer tests passed.');
