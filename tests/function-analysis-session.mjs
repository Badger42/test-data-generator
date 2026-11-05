import assert from 'node:assert/strict';
import { createFunctionAnalysisSession } from '../src/analysis/function-analysis-session.mjs';

const project = { relativeFile: 'src/target.ts' };
const functionUnit = { functionId: 'src/target.ts::target@10', name: 'target' };
const environment = {
  sessionId: functionUnit.functionId,
  project,
  functionUnit,
  limits: { maxScenarios: 12, maxAlternatives: 40, maxDepth: 4 },
  features: { generateMcdc: true, constraintEngine: 'hybrid' },
};

let calls = 0;
let retainedAnalysisPort;
const adapter = {
  analyze(received) {
    calls += 1;
    assert.equal(received.functionUnit, functionUnit);
    assert.equal(received.limits.maxScenarios, 12);
    assert.ok(Object.isFrozen(received.limits));
    assert.equal(typeof received.analysisState.dispatch, 'function');
    retainedAnalysisPort = received.analysisState;
    received.analysisState.dispatch({ type: 'analysis.branch-outcome-observed', key: 'if-1:true', branchId: 'if-1', outcome: true });
    received.analysisState.dispatch({ type: 'analysis.scenario-added', scenario: { id: 's1' } });
    return { name: 'target', summary: { scenariosGenerated: 1 }, scenarios: [{ id: 's1' }] };
  },
};

const session = createFunctionAnalysisSession(environment, adapter);
assert.equal(session.functionId, functionUnit.functionId);
assert.equal(session.snapshot.status, 'created');
assert.equal(session.analysisSnapshot.eventCount, 0);
const result = session.analyze();
assert.equal(result.name, 'target');
assert.ok(Object.isFrozen(result));
assert.ok(Object.isFrozen(result.scenarios));
assert.equal(session.snapshot.status, 'completed');
assert.equal(session.snapshot.eventCount, 2, 'lifecycle event count remains backward-compatible');
assert.ok(session.snapshot.completedAt >= session.snapshot.startedAt);
assert.equal(session.analysisSnapshot.branchCount, 1);
assert.equal(session.analysisSnapshot.scenarios[0].id, 's1');
assert.equal(session.analysisSnapshot.eventCount, 2);
assert.ok(Object.isFrozen(session.analysisSnapshot.scenarios));
assert.equal(calls, 1);
assert.throws(() => session.analyze(), /cannot run from state 'completed'/);
assert.throws(() => retainedAnalysisPort.dispatch({ type: 'analysis.loop-entered' }), /Cannot dispatch analysis event .* session is 'completed'/, 'a retained event port must not mutate a terminal session');

let failingPort;
const failing = createFunctionAnalysisSession(environment, {
  analyze(received) {
    failingPort = received.analysisState;
    received.analysisState.dispatch({ type: 'analysis.loop-entered' });
    throw new Error('adapter failure');
  },
});
assert.throws(() => failing.analyze(), /adapter failure/);
assert.equal(failing.snapshot.status, 'failed');
assert.equal(failing.snapshot.error, 'adapter failure');
assert.equal(failing.analysisSnapshot.eventCount, 1, 'partial analysis events remain inspectable after a failure');
assert.equal(failing.analysisSnapshot.loopCount, 1);
assert.throws(() => failingPort.dispatch({ type: 'analysis.loop-entered' }), /session is 'failed'/);

const second = createFunctionAnalysisSession({ ...environment, functionUnit: { ...functionUnit, functionId: 'other' } }, adapter);
assert.equal(second.snapshot.status, 'created');
assert.equal(session.snapshot.status, 'completed', 'sessions must not share lifecycle state');
assert.equal(second.analysisSnapshot.scenarios.length, 0, 'sessions must not share analysis accumulators');
console.log('Function analysis session tests passed.');
