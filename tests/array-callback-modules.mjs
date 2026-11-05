import assert from 'node:assert/strict';
import ts from 'typescript';
import { createAstFacade } from '../src/ast/ast-facade.mjs';
import { createArrayCallbackDiscovery } from '../src/analysis/arrays/callback-discovery.mjs';
import { createCallbackTraversal } from '../src/analysis/arrays/array-callback-analyzer.mjs';
import { createReduceStateInterpreter } from '../src/analysis/arrays/reduce-state-interpreter.mjs';
import { createArrayPipelineComposer } from '../src/analysis/arrays/pipeline/pipeline-composer.mjs';
import {
  ARRAY_CALLBACK_METHODS, ARRAY_REDUCE_METHODS, ARRAY_COMPARATOR_METHODS,
  getCallbackCardinalityVariants, getCallbackIterationIndices,
} from '../src/domain/array-method-policy.mjs';

const sourceFile = ts.createSourceFile('callbacks.ts', `
function sample(input) {
  return input.items.filter((item, index) => item.enabled && index > 0)
    .map(item => ({ id: item.id }))
    .some(mapped => mapped.id > 10);
}
function sum(input) {
  return input.values.reduce((acc, item) => acc + item, 0);
}
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const facade = createAstFacade(ts);
const fn = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'sample');
const expression = fn.body.statements[0].expression;
const parameterMap = new Map([['input', { index: 0 }]]);
const discovery = createArrayCallbackDiscovery({
  ts,
  unwrap: facade.unwrapExpression,
  getPathWithAliases: facade.getPathWithAliases,
  getLiteral: node => facade.readLiteral(node, Symbol.for('undefined')),
  isFunctionLikeCallback: node => Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))),
  callbackMethods: ARRAY_CALLBACK_METHODS,
  reduceMethods: ARRAY_REDUCE_METHODS,
  comparatorMethods: ARRAY_COMPARATOR_METHODS,
});
const discovered = [];
function visit(node) {
  if (!node) return;
  if (ts.isCallExpression(node)) {
    const descriptor = discovery.getDescriptor(node, { pathAliases: new Map(), parameterMap });
    if (descriptor) discovered.push(descriptor.method);
  }
  ts.forEachChild(node, visit);
}
visit(expression);
assert.deepEqual(discovered, ['some', 'map', 'filter'], 'nested array call stages are discovered outer-to-inner');
const outerDescriptor = discovery.getDescriptor(expression, { pathAliases: new Map(), parameterMap });
assert.equal(outerDescriptor.method, 'some');
assert.deepEqual(outerDescriptor.collectionPath, ['input', 'items']);
assert.deepEqual(outerDescriptor.pipeline.map(stage => stage.method), ['filter', 'map']);

const dispatched = [];
const callbackTraversal = createCallbackTraversal({
  ts,
  getDescriptor: discovery.getDescriptor,
  unwrap: facade.unwrapExpression,
  dispatchCall: call => { dispatched.push(call.expression.name.text); },
});
callbackTraversal.analyzeInNode(expression, [], { pathAliases: new Map(), parameterMap });
assert.deepEqual(dispatched, ['some', 'map', 'filter'], 'callback analyzer owns recursive pipeline traversal');

const variants = getCallbackCardinalityVariants('some', { itemValue: { id: 1 } });
assert.deepEqual(variants.map(item => item.outcome), ['zero-callbacks', 'one-callback', 'multiple-callbacks']);
assert.deepEqual(getCallbackCardinalityVariants('reduce', { itemValue: 1, hasInitialValue: true }).map(item => item.value.length), [0, 1, 2]);
assert.deepEqual(getCallbackIterationIndices('reduce', { hasInitialValue: true }), [0, 1, 2]);
assert.deepEqual(getCallbackIterationIndices('findLast', { callbackUsesIndex: true, hasReorderingPipeline: false }), [1, 0]);

const reduceFunction = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'sum');
const reduceCall = reduceFunction.body.statements[0].expression;
const reduceDescriptor = discovery.getDescriptor(reduceCall, { pathAliases: new Map(), parameterMap });
const interpreter = createReduceStateInterpreter({
  ts,
  unwrap: facade.unwrapExpression,
  getLiteral: node => facade.readLiteral(node, Symbol.for('undefined')),
  undefinedMarker: Symbol.for('undefined'),
  getPathWithAliases: facade.getPathWithAliases,
  cloneJson: value => value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
  setNestedValue: (target, path, value) => {
    let cursor = target;
    for (const segment of path.slice(0, -1)) cursor = cursor[segment] ??= {};
    cursor[path[path.length - 1]] = value;
  },
  getInputPathValue: () => undefined,
});
const itemExpression = reduceDescriptor.callback.body;
const evaluation = interpreter.evaluateExpression(itemExpression, new Map([
  ['acc', 10], ['item', 5],
]));
assert.deepEqual(evaluation, { ok: true, value: 15 });
const reduceSpecs = interpreter.getIterationSpecs(reduceDescriptor, 2, 1, {
  pathAliases: new Map(),
  inferredPaths: new Map(),
});
assert.ok(reduceSpecs.length > 0, 'bounded reducer interpreter derives reachable prior accumulator states');
assert.ok(reduceSpecs.every(spec => spec.accumulatorAlias?.kind === 'constant'));

const pipelineComposer = createArrayPipelineComposer({
  ts,
  comparatorMethods: ARRAY_COMPARATOR_METHODS,
  getCallbackSingleReturnExpression: callback => ts.isBlock(callback.body)
    ? callback.body.statements.find(ts.isReturnStatement)?.expression : callback.body,
  bindCallbackParameters: (callback, aliases, itemAlias, index) => {
    const [item, idx] = callback.parameters ?? [];
    if (item && ts.isIdentifier(item.name)) aliases.set(item.name.text, itemAlias);
    if (idx && ts.isIdentifier(idx.name)) aliases.set(idx.name.text, { kind: 'constant', value: index });
  },
  deriveMappedItemAlias: () => null,
  getCallbackPredicateSourceExpression: callback => callback.body,
  getNodeText: node => node.getText(sourceFile),
  aliasPathText: alias => alias?.path?.join('.') ?? 'unknown',
  aliasMetadata: alias => ({ kind: alias?.kind ?? 'unknown' }),
  inferComparatorOrder: () => null,
  comparatorOrderSolutions: () => [],
  getCallbackPredicateExpression: callback => callback.body,
  solveCondition: () => [{ assignments: new Map(), unsupported: [] }],
  unsupportedSolution: message => [{ assignments: new Map(), unsupported: [message] }],
  combineSolutions: (left, right) => left.flatMap(a => right.map(b => ({
    assignments: new Map([...a.assignments, ...b.assignments]),
    unsupported: [...a.unsupported, ...b.unsupported],
  }))),
});
const identityDescriptor = {
  collectionPath: ['input', 'items'], pipeline: [], callback: outerDescriptor.callback,
};
const pipeline = pipelineComposer.getPipelineContext(identityDescriptor, 0, { pathAliases: new Map() });
assert.deepEqual(pipeline.itemAlias.path, ['input', 'items', '0']);
assert.deepEqual(pipeline.requiredSourceIndexes, [0]);
assert.equal(pipeline.filterSolutions.length, 1);

console.log('Array callback modules passed: discovery, nested traversal, cardinality policy, reduce interpreter and pipeline composition.');
