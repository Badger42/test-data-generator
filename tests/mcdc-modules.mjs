import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { createMcdcDecisionExtractor } from '../src/mcdc/static/decision-extractor.mjs';
import { planUniqueCauseCandidates, verifyUniqueCauseCandidate } from '../src/mcdc/static/pair-planner.mjs';
import { createMcdcPairFeasibilityVerifier } from '../src/mcdc/static/pair-feasibility-verifier.mjs';
import { createMcdcScenarioMaterializer } from '../src/mcdc/static/scenario-materializer.mjs';
import { createMcdcSourceInstrumenter } from '../src/mcdc/runtime/source-instrumenter.mjs';
import { RUNTIME_MCDC_SYMBOL, createMcdcRuntimeRecorderSource } from '../src/mcdc/runtime/runtime-recorder.mjs';
import { normalizeRuntimeCollectionPath, verifyRuntimeMcdcSide } from '../src/mcdc/runtime/runtime-verifier.mjs';

const source = 'function check(a, b, c) { if (a && (!b || c)) return true; return false; }';
const sourceFile = ts.createSourceFile('mcdc-fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = sourceFile.statements.find(item => ts.isFunctionDeclaration(item));
const decisionNode = fn.body.statements.find(item => ts.isIfStatement(item)).expression;
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
};
const extractor = createMcdcDecisionExtractor({ ts, unwrap });
const atoms = extractor.collectAtomicConditions(decisionNode, sourceFile);
assert.equal(atoms.length, 3);
const atomMap = new Map(atoms.map((node, index) => [extractor.nodeKey(node, sourceFile), [true, false, false][index]]));
assert.equal(extractor.evaluateDecision(decisionNode, atomMap, sourceFile), true);

const logicalPairPlan = planUniqueCauseCandidates({
  atomCount: 2,
  targetIndex: 0,
  maxCombinations: 8,
  evaluateDecision: values => values[0] && values[1],
});
assert.equal(logicalPairPlan.candidates.length, 1);
assert.deepEqual(logicalPairPlan.candidates[0].fixedConditions, { C2: true });
assert.equal(verifyUniqueCauseCandidate(logicalPairPlan.candidates[0]), true);
assert.equal(logicalPairPlan.truncated, false);
const truncatedPlan = planUniqueCauseCandidates({
  atomCount: 5, targetIndex: 0, maxCombinations: 2, evaluateDecision: values => values.some(Boolean),
});
assert.equal(truncatedPlan.truncated, true);
assert.equal(truncatedPlan.combinationCount, 2);

const readPath = (root, parts) => {
  let value = root;
  for (const part of parts) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return { exists: false, value: undefined };
    value = value[part];
  }
  return { exists: true, value };
};
const feasibility = createMcdcPairFeasibilityVerifier({
  readPath,
  isStrictPathPrefix: (prefix, full) => prefix.length < full.length && prefix.every((part, i) => part === full[i]),
  sameValue: Object.is,
  undefinedValue: undefined,
});
const seed = { input: { passenger: { age: 20 } } };
assert.equal(feasibility.preservesIncomingAssignments(seed, { input: { passenger: { age: 21 } } }, [
  { path: ['input', 'passenger'], value: { age: 20 } },
], [{ path: ['input', 'passenger', 'age'] }]), true, 'refining a previously seeded parent object is allowed');
assert.equal(feasibility.preservesIncomingAssignments(seed, { input: { passenger: { age: 21 } } }, [
  { path: ['input', 'passenger', 'age'], value: 20 },
], [{ path: ['input', 'passenger', 'age'] }]), false, 'an explicitly constrained target leaf cannot change');
assert.equal(feasibility.preservesIncomingAssignments(seed, { input: { passenger: { age: 20 } } }, [
  { path: ['input', 'passenger', 'age'], value: 20, lengthConstraint: { min: 1 } },
], [{ path: ['input', 'passenger', 'age'] }], [{ kind: 'integer-length', path: ['input', 'passenger', 'age'] }]), true, 'symbolic length domains can be refined by the solver witness');

const materialize = createMcdcScenarioMaterializer({
  cloneValue: value => structuredClone(value),
  applyAssignment(args, assignment, parameterMap, localMockMap, checker, node, mockValues) {
    if (assignment.kind === 'argument') args[0][assignment.key] = assignment.value;
    else mockValues.set(assignment.call, { call: assignment.call, behavior: 'mockResolvedValue', resolvedValue: assignment.value });
  },
  serializeValue: value => value,
});
const materialized = materialize({
  solution: { assignments: new Map([
    ['input.age', { kind: 'argument', key: 'age', value: 31 }],
    ['pricing.fare', { kind: 'mock', call: 'pricing.getFare', value: { amount: 120 } }],
  ]) },
  context: { baseArgs: [{ age: 0 }], parameterMap: new Map(), localMockMap: new Map(), checker: null, activeAnalysisMetadata: { callbackMethod: 'map', iterationIndex: 1 } },
  node: null, scenarioId: 'pair-false', conditionValues: { C1: false, C2: true }, decisionOutcome: false,
});
assert.deepEqual(materialized.arguments, [{ age: 31 }]);
assert.equal(materialized.mocks[0].resolvedValue.amount, 120);
assert.equal(materialized.callbackContext.iterationIndex, 1);

const instrumenter = createMcdcSourceInstrumenter({
  ts,
  getScriptKindForRuntimeInstrumentation: () => ts.ScriptKind.TS,
  findNodeForSourceRange(sf, start, end) {
    let found = null;
    const visit = node => {
      if (node.getStart(sf) === start && node.end === end) { found = node; return; }
      if (found || node.getStart(sf) > start || node.end < end) return;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  },
  inspectRuntimeExpression(node) {
    let hasAwait = false, hasYield = false, hasDirectEval = false;
    const visit = current => {
      if (current !== node && ts.isFunctionLike(current)) return;
      hasAwait ||= ts.isAwaitExpression(current);
      hasYield ||= ts.isYieldExpression(current);
      hasDirectEval ||= ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'eval';
      ts.forEachChild(current, visit);
    };
    visit(node);
    let asyncContext = false;
    for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) { asyncContext = Boolean(current.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)); break; }
    return { hasAwait, hasYield, hasDirectEval, asyncContext };
  },
});
const conditionRanges = atoms.map((node, index) => ({ id: `C${index + 1}`, expression: node.getText(sourceFile), runtimeExpressionRange: { startOffset: node.getStart(sourceFile), endOffset: node.end } }));
const instrumented = instrumenter('mcdc-fixture.ts', source, [{ mcdc: { decisions: [{
  decisionId: 'decision-1', expression: decisionNode.getText(sourceFile),
  runtimeExpressionRange: { startOffset: decisionNode.getStart(sourceFile), endOffset: decisionNode.end },
  conditions: conditionRanges,
}] } }]);
assert.equal(instrumented.instrumentation.decisionsInstrumented, 1);
assert.equal(instrumented.instrumentation.conditionsInstrumented, 3);
assert.match(instrumented.source, /\.decision\(/);
assert.match(instrumented.source, /\.condition\(/);

const sandbox = { Symbol, Map, Boolean, Object };
const runtime = vm.runInNewContext(`${createMcdcRuntimeRecorderSource()}\nglobalThis[Symbol.for(${JSON.stringify(RUNTIME_MCDC_SYMBOL)})]`, sandbox);
assert.ok(runtime);
runtime.beginCase('case-1');
const decisionResult = runtime.decision('decision-1', () =>
  runtime.condition('decision-1', 'C1', () => true) && runtime.condition('decision-1', 'C2', () => false));
assert.equal(decisionResult, false);
assert.equal(runtime.snapshot()[0].decisionOutcome, false);
assert.equal(runtime.snapshot()[0].conditions.C1.value, true);
assert.equal(runtime.snapshot()[0].conditions.C2.value, false);
const previous = runtime.enterCallback({ method: 'map', collection: 'items', iterationIndex: 0 });
runtime.decision('callback-decision', () => runtime.condition('callback-decision', 'C1', () => true));
runtime.leaveCallback(previous);
assert.equal(runtime.snapshot()[1].callbackContext.method, 'map');
assert.equal(normalizeRuntimeCollectionPath('items[0].fare'), 'items.0.fare');

const pair = { pairId: 'p1', decisionId: 'd1', conditionId: 'C1' };
const cases = [{ id: 'case-1', references: [{ pairId: 'p1', side: 'conditionFalse', mcdcAssertion: {
  expectedDecisionOutcome: false, expectedAtomicConditionValues: { C1: false, C2: true },
} }] }];
const trace = [{ caseId: 'case-1', decisionId: 'd1', executionStatus: 'completed', decisionOutcome: false,
  conditions: { C1: { evaluated: true, value: false }, C2: { evaluated: true, value: true } } }];
assert.equal(verifyRuntimeMcdcSide(trace, cases, 'case-1', pair, 'conditionFalse', { status: 'verified' }).status, 'runtime-instrumented-verified');
assert.equal(verifyRuntimeMcdcSide([], cases, 'case-1', pair, 'conditionFalse', { status: 'verified' }).status, 'decision-not-observed');

console.log('MC/DC modules passed: decision extraction, unique-cause planning, feasibility, scenario materialization, source instrumentation, recorder and runtime verification.');
