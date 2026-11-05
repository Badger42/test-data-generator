import assert from 'node:assert/strict';
import { loadTypescriptProject } from '../src/project/load-typescript-project.mjs';
import { discoverFunctions } from '../src/project/discover-functions.mjs';
import { createFunctionAnalysisSession } from '../src/analysis/function-analysis-session.mjs';
import { createFunctionAnalyzerAdapter } from '../src/analysis/function-analyzer-adapter.mjs';
import { analyzeFunction } from '../src/runtime/typescript-analysis-runtime.mjs';

const project = loadTypescriptProject({ file: 'examples/passenger.js' });
const [functionUnit] = discoverFunctions(project.sourceFile, { relativeFile: project.relativeFile });
const adapter = createFunctionAnalyzerAdapter(analyzeFunction);

function createSession(sessionId, maxAlternatives, generateMcdc = true) {
  return createFunctionAnalysisSession({
    sessionId,
    project,
    functionUnit,
    limits: { maxScenarios: 12, maxAlternatives, maxDepth: 4 },
    features: { generateMcdc, constraintEngine: 'hybrid' },
  }, adapter);
}

const first = createSession('passenger-analysis-a', 40);
const second = createSession('passenger-analysis-b', 2, false);
const firstResult = first.analyze();
const secondResult = second.analyze();
const firstState = first.analysisSnapshot;
const secondState = second.analysisSnapshot;

assert.equal(firstState.scenarios.length, firstResult.scenarios.length);
assert.equal(secondState.scenarios.length, secondResult.scenarios.length);
assert.equal(firstState.branchCount, firstResult.summary.branchOutcomesFound);
assert.equal(secondState.branchCount, secondResult.summary.branchOutcomesFound);
assert.equal(firstState.unsupportedBranches.length, firstResult.unsupportedBranches.length);
assert.equal(firstState.loopCount, firstResult.summary.loopsAnalyzed);
assert.equal(firstState.loopScenariosGenerated, firstResult.summary.loopScenariosGenerated);
assert.equal(firstState.mcdcDecisions.length, firstResult.summary.mcdcDecisionsAnalyzed);
assert.equal(firstState.mcdcConditions, firstResult.summary.mcdcConditionsAnalyzed);
assert.equal(firstState.mcdcPairs, firstResult.summary.mcdcIndependencePairsFound);
assert.deepEqual(firstResult._constraintStats, firstState.constraintStats);
assert.ok(firstState.eventCount > 0);
assert.ok(Object.isFrozen(firstState));
assert.ok(Object.isFrozen(firstState.scenarios));
assert.ok(Object.isFrozen(firstState.scenarios[0]));

assert.notEqual(firstState, secondState);
assert.notEqual(firstState.scenarios, secondState.scenarios);
assert.equal(first.snapshot.status, 'completed');
assert.equal(second.snapshot.status, 'completed');
assert.ok(firstState.eventCount > secondState.eventCount, 'MC/DC-enabled session must record its additional analysis events');
assert.ok(firstState.mcdcDecisions.length > 0);
assert.equal(secondState.mcdcDecisions.length, 0);
assert.equal(secondState.mcdcPairs, 0);
console.log('Session-owned analysis integration passed: reducer snapshots match complete analyzer-adapter results and remain isolated across different budgets.');
