import assert from 'node:assert/strict';
import { createAnalysisOperationContext } from '../src/analysis/analysis-operation-context.mjs';

const events = [];
const context = {
  coverageExpansion: true,
  fn: { name: 'first' },
  sourceFile: { fileName: 'first.ts' },
  checker: { id: 'checker-1' },
  maxScenarios: 12,
  maxAlternatives: 7,
  constraintEngine: 'hybrid',
  constraintSolver: { id: 'solver-1' },
  expressionAliasResolver: { id: 'aliases' },
  parameterMap: new Map([['input', { index: 0 }]]),
  localMockMap: new Map(),
  pathAliases: new Map([['age', { kind: 'path', path: ['input', 'age'] }]]),
  inferredPaths: new Map(),
  localConstants: new Map(),
  activeAnalysisMetadata: { callbackMethod: 'some', iterationIndex: 1 },
  arrayCallbackSeen: new Set(['callback-1']),
  arrayPipelineSeen: new Set(['pipeline-1']),
  generateMcdc: true,
  mcdcDecisionSeen: new Set(['decision-1']),
};
const operation = createAnalysisOperationContext(context, {
  maxMcdcAtoms: 10,
  maxMcdcCombinations: 512,
  dispatch: (owner, event) => events.push([owner, event]),
  incrementConstraintStat: (owner, key, amount) => events.push([owner, { type: 'stat', key, amount }]),
  recordConstraintFallback: (owner, reason) => events.push([owner, { type: 'fallback', reason }]),
});

assert.ok(Object.isFrozen(operation));
for (const section of ['function', 'limits', 'constraints', 'paths', 'arrays', 'mcdc', 'events']) {
  assert.ok(Object.isFrozen(operation[section]), `${section} port must be immutable`);
}
assert.equal(operation.function.node, context.fn);
assert.equal(operation.function.sourceFile, context.sourceFile);
assert.equal(operation.function.checker, context.checker);
assert.deepEqual(operation.limits, { maxScenarios: 12, maxAlternatives: 7, coverageExpansion: true, maxMcdcAtoms: 10, maxMcdcCombinations: 512 });
assert.equal(operation.constraints.engine, 'hybrid');
assert.equal(operation.constraints.solver, context.constraintSolver);
assert.equal(operation.paths.pathAliases, context.pathAliases);
assert.equal(operation.arrays.metadata, context.activeAnalysisMetadata);
assert.equal(operation.mcdc.enabled, true);
assert.equal(operation.function.typeModelProvider, context.typeModelProvider ?? null);
assert.equal(operation.limits.coverageExpansion, true);
assert.equal(operation.paths.parameterMap, context.parameterMap);

operation.events.dispatch({ type: 'custom-event' });
operation.events.incrementConstraintStat('irSolved', 2);
operation.events.recordConstraintFallback('unknown atom');
assert.equal(events.length, 3);
assert.ok(events.every(([owner]) => owner === context));
assert.deepEqual(events.map(([, event]) => event.type), ['custom-event', 'stat', 'fallback']);

const secondContext = { ...context, fn: { name: 'second' }, pathAliases: new Map(), constraintSolver: { id: 'solver-2' } };
const secondOperation = createAnalysisOperationContext(secondContext);
assert.notEqual(secondOperation, operation);
assert.notEqual(secondOperation.function.node, operation.function.node);
assert.notEqual(secondOperation.paths.pathAliases, operation.paths.pathAliases);
assert.notEqual(secondOperation.constraints.solver, operation.constraints.solver);

console.log('AnalysisOperationContext tests passed: immutable named ports, event routing and per-invocation isolation verified.');
