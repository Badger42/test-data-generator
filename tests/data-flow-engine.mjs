import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createTypeScriptDataFlowAnalyzer } from '../src/data-flow/index.mjs';
import { createDataFlowAnalyzerAdapter } from '../src/data-flow/data-flow-adapter.mjs';
import { createExpressionAliasResolver } from '../src/data-flow/typescript-expression-facts.mjs';
import { buildArrayPipelineDataFlow } from '../src/data-flow/arrays/array-pipeline-flow.mjs';
import { compileTypescriptCondition } from '../src/constraints/compile-typescript-condition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/data-flow-engine.ts');
const program = ts.createProgram([fixture], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
});
const sourceFile = program.getSourceFile(fixture);
const checker = program.getTypeChecker();
const functions = new Map();
const visit = node => {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
};
visit(sourceFile);
const analyzer = createTypeScriptDataFlowAnalyzer(ts);
const functionUnit = node => ({
  functionId: `tests/fixtures/data-flow-engine.ts::${node.name.text}@${node.getStart(sourceFile)}`,
  name: node.name.text,
  astNode: node,
});

const result = analyzer.analyzeWithCompilerBindings({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('analyzeInput')),
});
const model = result.dataModel;
assert.ok(model.ssa.definitions.some(item => item.name === 'total' && item.kind === 'declaration'));
assert.ok(model.ssa.definitions.some(item => item.name === 'total' && item.kind === 'assignment'));
assert.ok(model.ssa.phiNodes.some(item => item.name === 'total' && item.kind === 'branch-merge'), 'if/else assignment must create a phi node');
assert.ok(model.aliases.some(item => item.alias === 'userAlias' && item.relation === 'must-alias'));
assert.ok(model.mutations.some(item => item.kind === 'property-write' && item.path.join('.') === 'input.user.score'), 'mutation through a must-alias must resolve to the original object path');
assert.ok(model.mutations.some(item => item.kind === 'known-mutator' && item.path.join('.') === 'input.items' && item.method === 'push'));
assert.equal(model.interprocedural.rootPurity, 'impure', 'root function purity must include its own explicit mutations');
assert.ok(model.interprocedural.rootEffects.some(item => item.path.join('.') === 'input.user.score' && item.propagation === 'direct-root'));
const calculateSummary = model.functionSummaries.find(item => item.name === 'calculate');
const incrementSummary = model.functionSummaries.find(item => item.name === 'incrementUser');
assert.ok(calculateSummary);
assert.equal(calculateSummary.purity, 'pure');
assert.equal(calculateSummary.returns[0].expressionText, 'total * factor');
assert.deepEqual(calculateSummary.returns[0].dependencies.sort(), ['factor', 'total']);
assert.equal(calculateSummary.inlineable, false, 'summaries must not be auto-inlined without validated call semantics');
assert.ok(incrementSummary);
assert.equal(incrementSummary.purity, 'impure');
assert.ok(incrementSummary.effects.some(item => item.path.join('.') === 'input.user.score'));
assert.ok(model.callSites.some(item => item.callee === 'calculate' && item.targetFunctionId === calculateSummary.functionId));
assert.ok(model.properties.some(item => item.path.rootName === 'input' && item.path.segments.join('.') === 'items' && item.kind === 'array'));
assert.ok(model.properties.some(item => item.path.rootName === 'input' && item.path.segments.join('.') === 'base' && item.kind === 'number'));
assert.ok(model.properties.some(item => item.path.rootName === 'input' && item.path.segments.join('.') === 'user.score'), 'properties reached through local aliases should normalize to the original path');
assert.doesNotThrow(() => JSON.stringify(model), 'DataModel must be JSON-safe and contain no compiler AST nodes or symbols');
assert.equal(result.compilerFacts.expressionAliases instanceof Map, true, 'compiler-only bindings stay in the explicit compiler adapter result');
assert.ok(model.controlFlowGraph.nodes.some(item => item.kind === 'if-condition'));
assert.ok(model.controlFlowGraph.edges.some(item => item.kind === 'true'));
assert.ok(model.controlFlowGraph.edges.some(item => item.kind === 'false'));
assert.ok(model.controlFlowAnalysis.dominators[model.controlFlowGraph.exit].length > 0, 'exit must have computed dominators');
assert.ok(model.controlFlowAnalysis.dominanceFrontiers, 'dominance frontiers must be serialized');
assert.equal(model.controlFlowAnalysis.convergence.postDominators, true, 'post-dominators must reach a fixed point on terminating fixtures');
assert.ok(Object.values(model.controlFlowAnalysis.controlDependence).some(controllers => controllers.some(id => model.controlFlowGraph.nodes.find(node => node.id === id)?.kind === 'expression-condition')), 'branch body nodes must retain their expression-condition control dependencies');
assert.ok(model.flowAnalysis.convergence.reachingDefinitions && model.flowAnalysis.convergence.liveness, 'reaching-definitions and liveness must converge');
assert.ok(model.flowAnalysis.phiCandidates.some(item => item.name === 'total'), 'dominance frontiers must identify the if/else merge phi candidate');
assert.ok(model.ssa.cfgAware.phiNodes.some(item => item.name === 'total'), 'CFG-aware phi placement must be attached to the SSA result');
assert.ok(model.ssa.cfgAware.uses.some(item => item.name === 'total' && item.resolution === 'phi-candidate'), 'uses after the branch join must resolve through the phi candidate');
assert.ok(Object.keys(model.flowAnalysis.reachingDefinitions).length > 0);
assert.ok(model.ssa.controlFlowGraph.nodeCount > 0);
assert.ok(model.ssa.definitions.some(item => item.cfgNodeId), 'SSA definitions should reference their CFG statement nodes');

const frozenPublicModel = Object.freeze({
  ...model,
  properties: Object.freeze([...model.properties]),
  aliases: Object.freeze([...model.aliases]),
  warnings: Object.freeze([...model.warnings]),
});
const adapterResult = createDataFlowAnalyzerAdapter({
  analyzeWithCompilerBindings: () => ({ dataModel: frozenPublicModel, compilerFacts: result.compilerFacts }),
}, {
  analyze: environment => {
    assert.notStrictEqual(environment.dataFlowModel, frozenPublicModel);
    environment.dataFlowModel.properties = [];
    environment.dataFlowModel.aliases = [];
    environment.dataFlowModel.warnings = [];
    return environment.dataFlowModel;
  },
}).analyze({ project: {}, functionUnit: {} });
assert.deepEqual(frozenPublicModel.properties, model.properties, 'compatibility consumers must not mutate the Data Flow-owned model');
assert.equal(adapterResult.properties.length, 0);
assert.ok(adapterResult._dataFlowModel, 'the adapter should retain the finalized DataModel outside the public report schema');
assert.equal(Object.keys(adapterResult).includes('_dataFlowModel'), false, 'internal DataModel metadata must not leak into report JSON');
const pipelineSnapshot = [{
  id: 'pipeline:test',
  sourceExpression: 'input.flights.filter(x => x.active).sort(compare).flatMap(x => x.passengers)',
  collection: 'input.flights', resultKind: 'array', elementAlias: { kind: 'path', path: ['input', 'flights', 1, 'passengers', 0] },
  requiredSourceIndexes: [0, 1], assumptions: ['representative-only'], warnings: [],
  stages: [
    { index: 0, method: 'filter', input: 'input.flights[1]', output: 'input.flights[1]', predicate: 'x.active', cardinality: 'may-shrink', order: 'stable' },
    { index: 1, method: 'sort', input: 'input.flights[1]', output: 'input.flights[1]', comparatorEvidence: 'left.value - right.value', ordering: 'ascending', mutation: 'mutates-receiver' },
    { index: 2, method: 'flatMap', input: 'input.flights[1]', output: 'input.flights[1].passengers[0]', cardinality: 'expands-zero-or-more', mappingAssumption: 'one-representative-first-child-per-source-element' },
  ],
}];
const pipelineAdapterResult = createDataFlowAnalyzerAdapter({
  analyzeWithCompilerBindings: () => ({ dataModel: frozenPublicModel, compilerFacts: result.compilerFacts }),
}, { analyze: () => ({ name: 'withPipeline' }) }).analyze({
  project: {}, functionUnit: {}, analysisState: { snapshot: () => ({ arrayPipelines: pipelineSnapshot }) },
});
assert.deepEqual(pipelineAdapterResult._dataFlowModel.arrayPipelines, pipelineSnapshot, 'session-owned Array Pipeline facts must be merged into the completed FunctionDataModel');
assert.equal(pipelineAdapterResult._dataFlowModel.arrayPipelineFlow.pipelineCount, 1);
assert.equal(pipelineAdapterResult._dataFlowModel.arrayPipelineFlow.stageCount, 3);
assert.equal(pipelineAdapterResult._dataFlowModel.arrayPipelineFlow.pipelines[0].edges.length, 2);
assert.equal(pipelineAdapterResult._dataFlowModel.arrayPipelineFlow.pipelines[0].provenance.exactSourceIndexMapping, false, 'filter/sort/flatMap must not claim exact source index preservation');
assert.ok(Object.isFrozen(pipelineAdapterResult._dataFlowModel));

const interproceduralResult = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('interproceduralCalls')),
});
const invokeSummary = interproceduralResult.functionSummaries.find(item => item.name === 'invoke');
assert.ok(invokeSummary);
assert.equal(invokeSummary.purity, 'impure', 'callee effects should propagate through local function calls');
assert.ok(invokeSummary.transitiveEffects.some(item => item.path.join('.') === 'target.value'));
assert.ok(interproceduralResult.interprocedural.rootEffects.some(item => item.path.join('.') === 'input.value'), 'root call arguments should be substituted into transitive effects');
assert.equal(interproceduralResult.interprocedural.rootPurity, 'impure');

const ambiguousResult = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('ambiguousLocalHelpers')),
});
assert.equal(ambiguousResult.interprocedural.rootPurity, 'impure', 'symbol-resolved same-name local helpers must propagate their effects');
assert.ok(ambiguousResult.callSites.every(site => site.resolution === 'local-summary'), 'lexically distinct same-name local helpers must resolve by TypeScript symbol identity');

const recursiveResult = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('recursiveLocalCall')),
});
assert.ok(recursiveResult.interprocedural.recursiveComponents.length > 0);
assert.equal(recursiveResult.functionSummaries.find(item => item.name === 'descend').purity, 'unknown', 'recursive summaries must not be treated as pure without a fixed-point proof');

const returnSubstitutionModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('returnSubstitution')),
});
const returnFacts = returnSubstitutionModel.interprocedural.returnValueFacts;
assert.equal(returnFacts.length, 2, 'each call site must retain a distinct context-sensitive return binding');
assert.ok(returnFacts.every(item => item.complete && item.usableAsConstraintAlias));
assert.deepEqual(returnFacts.map(item => item.values[0].path), [['input', 'left', 'value'], ['input', 'right', 'value']]);

const contextSensitiveModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('contextSensitiveEffects')),
});
const contextGraph = contextSensitiveModel.interprocedural.contextSensitive;
const mutateContexts = contextGraph.contexts.filter(item => item.functionName === 'mutate');
assert.equal(mutateContexts.length, 2, 'the same nested helper must be instantiated in two separate call-string contexts');
assert.deepEqual(mutateContexts.map(item => item.transitiveEffects[0].path.join('.')).sort(), ['input.left.value', 'input.right.value']);
assert.equal(new Set(mutateContexts.map(item => item.contextId)).size, 2, 'call-site contexts must not collapse by callee identity');
assert.ok(mutateContexts.every(item => item.purity === 'impure'));

const ssaDerivedFunction = functions.get('ssaDerivedConstraint');
const ssaDerivedAnalysis = analyzer.analyzeWithCompilerBindings({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(ssaDerivedFunction),
});
const ssaResolver = createExpressionAliasResolver(ssaDerivedAnalysis.compilerFacts, checker);
const ssaConditions = ssaDerivedFunction.body.statements.filter(statement => ts.isIfStatement(statement));
const ssaCondition = ssaConditions[1].expression;
const ssaIr = compileTypescriptCondition(ssaCondition, ts, {
  resolveAlias: ssaResolver,
  isSymbolicRoot: identifier => Boolean(ssaResolver(identifier)) || ts.isParameter(identifier.parent),
  isNumericExpression: expression => Boolean(checker.getTypeAtLocation(expression).flags & ts.TypeFlags.NumberLike),
});
assert.deepEqual(ssaIr.atoms[0].path, ['input', 'value'], 'the compiler must resolve a local use through its SSA version and same-path phi');
assert.ok(ssaDerivedAnalysis.compilerFacts.ssaUseAliases.size > 0);

const ssaAmbiguousFunction = functions.get('ssaAmbiguousConstraint');
const ssaAmbiguousAnalysis = analyzer.analyzeWithCompilerBindings({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(ssaAmbiguousFunction),
});
const ambiguousCondition = ssaAmbiguousFunction.body.statements.find(statement => ts.isReturnStatement(statement)).expression;
const ambiguousResolver = createExpressionAliasResolver(ssaAmbiguousAnalysis.compilerFacts, checker);
assert.equal(ambiguousResolver(ambiguousCondition.left), null, 'a phi merging different source paths must not be exposed as a solver alias');

const pointsToModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('pointsToAliasing')),
});
const pointsToPair = pointsToModel.pointsTo.aliasPairs.find(item =>
  pointsToModel.pointsTo.symbols[item.leftSymbolId] === 'first' || pointsToModel.pointsTo.symbols[item.rightSymbolId] === 'first');
assert.ok(pointsToPair, 'flow-insensitive points-to must retain the shared allocation site across conditional aliases');
assert.equal(pointsToPair.relation, 'may-alias');
assert.ok(pointsToModel.memorySsa.pointsTo.propagatedWrites > 0, 'points-to alias effects must reach heap memory SSA');
assert.ok(pointsToModel.memorySsa.accesses.some(item => item.kind === 'write' && item.effectKind === 'points-to-may-alias-effect' && item.rootName === 'first' && item.updateMode === 'weak'));

const fieldLoadPointsToModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('pointsToFieldLoad')),
});
const fieldLoadAlias = fieldLoadPointsToModel.pointsTo.aliasPairs.find(item =>
  fieldLoadPointsToModel.pointsTo.symbols[item.leftSymbolId] === 'child' &&
  fieldLoadPointsToModel.pointsTo.symbols[item.rightSymbolId] === 'loaded');
assert.equal(fieldLoadAlias?.relation, 'must-alias', 'field loads must resolve through points-to heap-field constraints');
assert.ok(fieldLoadPointsToModel.memorySsa.accesses.some(item => item.kind === 'write' && item.rootName === 'child' && item.path.join('.') === 'value' && item.location === fieldLoadPointsToModel.memorySsa.locations.find(location => location.rootName === 'child' && location.path.join('.') === 'value')?.id && item.updateMode === 'strong'), 'heap writes through field-loaded references must canonicalize to the shared allocation-site memory location');

const externalPointsToModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('pointsToExternalAlias')),
});
assert.ok(externalPointsToModel.pointsTo.aliasPairs.some(item => item.relation === 'may-alias' && item.reason === 'external-parameter-regions-may-overlap'), 'separate object parameters must remain potentially aliased');
assert.ok(externalPointsToModel.memorySsa.accesses.some(item => item.kind === 'write' && item.rootName === 'right' && item.updateMode === 'weak'), 'external-parameter aliasing must only create weak updates');

const indexFlow = buildArrayPipelineDataFlow([{
  id: 'pipeline:index-flow', collection: 'input.items', resultKind: 'array', requiredSourceIndexes: [0, 1],
  stages: [
    { index: 0, method: 'filter', input: 'input.items[0]', output: 'filtered[0]', predicate: 'item.active' },
    { index: 1, method: 'slice', start: 1, input: 'filtered[0]', output: 'window[0]' },
    { index: 2, method: 'reverse', representativeLength: 2, input: 'window[0]', output: 'reversed[0]' },
  ],
}]).pipelines[0];
assert.equal(indexFlow.stages[0].indexTransform.kind, 'filtered-rank');
assert.equal(indexFlow.stages[1].indexTransform.kind, 'slice-offset');
assert.equal(indexFlow.stages[2].indexTransform.kind, 'reverse');
assert.ok(indexFlow.sourceMappings.every(item => !item.exact), 'a composed filter/slice/reverse mapping must remain symbolic rather than claim static identity');
assert.ok(indexFlow.sourceMappings[0].outputIndexExpression.includes('rankAfterFilter'));
const positiveSliceFlow = buildArrayPipelineDataFlow([{
  id: 'pipeline:positive-slice', collection: 'input.items', resultKind: 'array', requiredSourceIndexes: [0, 1, 3],
  stages: [{ index: 0, method: 'slice', start: 1, end: 3, input: 'input.items', output: 'window' }],
}]).pipelines[0];
assert.deepEqual(positiveSliceFlow.sourceMappings.map(item => item.excluded), [true, false, true], 'positive slice bounds should exclude source indexes only while the prefix mapping is exact');
const negativeSliceFlow = buildArrayPipelineDataFlow([{
  id: 'pipeline:negative-slice', collection: 'input.items', resultKind: 'array', requiredSourceIndexes: [0, 1],
  stages: [{ index: 0, method: 'slice', start: -2, input: 'input.items', output: 'tail' }],
}]).pipelines[0];
assert.ok(negativeSliceFlow.sourceMappings.every(item => !item.excluded && !item.exact && item.outputIndexExpression.includes('length(input.items)')), 'negative slice bounds must remain length-relative and symbolic');

const pureHelperFunction = functions.get('pureHelperConstraint');
const pureHelperAnalysis = analyzer.analyzeWithCompilerBindings({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(pureHelperFunction),
});
const aliasResolver = createExpressionAliasResolver(pureHelperAnalysis.compilerFacts, checker);
const currentValueDeclaration = pureHelperFunction.body.statements.filter(statement => ts.isVariableStatement(statement))
  .flatMap(statement => [...statement.declarationList.declarations]).find(declaration => declaration.name.text === 'currentValue');
const currentValueSymbol = checker.getSymbolAtLocation(currentValueDeclaration.name);
assert.deepEqual(pureHelperAnalysis.compilerFacts.expressionAliases.get(currentValueSymbol).path, ['input', 'value']);
assert.ok(!pureHelperAnalysis.compilerFacts.mockBindings.has(currentValueSymbol), 'a local pure helper result must not be misclassified as a mock');
const helperCondition = pureHelperFunction.body.statements.find(statement => ts.isIfStatement(statement)).expression;
const helperIr = compileTypescriptCondition(helperCondition, ts, {
  resolveAlias: aliasResolver,
  isSymbolicRoot: identifier => Boolean(aliasResolver(identifier)) || ts.isParameter(identifier.parent),
  isNumericExpression: expression => Boolean(checker.getTypeAtLocation(expression).flags & ts.TypeFlags.NumberLike),
});
assert.equal(helperIr.atoms[0].path.join('.'), 'input.value', 'Constraint IR must consume validated pure local helper return aliases');
const computedHelperFunction = functions.get('computedHelperConstraint');
const computedHelperAnalysis = analyzer.analyzeWithCompilerBindings({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(computedHelperFunction),
});
const computedReturnFact = computedHelperAnalysis.dataModel.interprocedural.returnValueFacts[0];
assert.equal(computedReturnFact.complete, false, 'computed helper returns must remain incomplete instead of being guessed as a path');
assert.equal(computedReturnFact.usableAsConstraintAlias, false, 'computed helper returns must not be exposed as symbolic path aliases');
const computedDeclaration = computedHelperFunction.body.statements.filter(statement => ts.isVariableStatement(statement))
  .flatMap(statement => [...statement.declarationList.declarations]).find(declaration => declaration.name.text === 'computed');
assert.ok(!computedHelperAnalysis.compilerFacts.expressionAliases.has(checker.getSymbolAtLocation(computedDeclaration.name)), 'unproven computed return aliases must not enter the Constraint Compiler alias map');
const constantHelperModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('constantReturnHelper')),
});
const constantReturnFact = constantHelperModel.interprocedural.returnValueFacts[0];
assert.equal(constantReturnFact.complete, true);
assert.deepEqual(constantReturnFact.values[0], { kind: 'constant', value: true, confidence: 'high' });
assert.equal(constantReturnFact.usableAsConstraintAlias, false, 'constant results are facts, not property-path aliases');

const reduceModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('reduceAccumulator')),
});
assert.equal(reduceModel.reduceFlows.length, 1);
assert.equal(reduceModel.reduceFlows[0].accumulator.name, 'accumulator');
assert.equal(reduceModel.reduceFlows[0].initialValue.provided, true);
assert.ok(reduceModel.reduceFlows[0].hasAccumulatorRecurrence);

const loopModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('mutateLoop')),
});
assert.ok(loopModel.ssa.phiNodes.some(item => item.name === 'total' && item.kind === 'loop-carried'));
assert.ok(loopModel.ssa.phiNodes.some(item => item.name === 'index' && item.kind === 'loop-carried'));
assert.ok(loopModel.controlFlowAnalysis.naturalLoops.length > 0);
assert.ok(loopModel.loopFlow.loops.some(item => item.carriedVariables.some(variable => variable.name === 'total')));
const loopReturn = loopModel.controlFlowGraph.nodes.find(node => node.kind === 'return');
assert.ok(loopModel.controlFlowAnalysis.naturalLoops.every(loop => !loop.nodes.includes(loopReturn.id)), 'normal code after a loop must not be absorbed into the natural-loop region');
const transferModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('controlFlowTransfers')),
});
const transferKinds = transferModel.controlFlowGraph.edges.map(edge => edge.kind);
assert.ok(transferKinds.includes('break'));
assert.ok(transferKinds.includes('continue'));
assert.ok(transferModel.loopFlow.loops.some(item => item.breakEdges.length && item.continueEdges.length));
assert.ok(transferKinds.includes('fallthrough'));
const doModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('doWhileControlFlow')),
});
const doEntry = doModel.controlFlowGraph.nodes.find(node => node.kind === 'do-body-entry');
const doHeader = doModel.controlFlowGraph.nodes.find(node => node.kind === 'do-header');
assert.ok(doModel.controlFlowGraph.edges.some(edge => edge.to === doEntry.id), 'do/while must enter its body before checking the condition');
assert.ok(doModel.controlFlowGraph.edges.some(edge => edge.from === doHeader.id && edge.kind === 'evaluate'));
const doExit = doModel.controlFlowGraph.nodes.find(node => node.kind === 'do-exit');
assert.ok(doModel.controlFlowGraph.edges.some(edge => edge.kind === 'false' && edge.to === doExit.id), 'the do/while false outcome must exit from its expression-condition node');
const doNaturalLoop = doModel.controlFlowAnalysis.naturalLoops[0];
const doReturn = doModel.controlFlowGraph.nodes.find(node => node.kind === 'return');
assert.ok(doNaturalLoop?.nodes.includes(doEntry.id), 'the do/while natural loop must include the body entry');
assert.ok(!doNaturalLoop?.nodes.includes(doReturn.id), 'do/while exit code must remain outside the loop region');
const compoundConditionModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('shortCircuitControlFlow')),
});
const conditionNodes = compoundConditionModel.controlFlowGraph.nodes.filter(node => node.kind === 'expression-condition');
assert.ok(conditionNodes.length >= 4, '&&, || and ternary expressions must expand into executable condition nodes');
assert.ok(compoundConditionModel.controlFlowGraph.edges.some(edge => edge.kind === 'true') && compoundConditionModel.controlFlowGraph.edges.some(edge => edge.kind === 'false'));
assert.ok(compoundConditionModel.flowAnalysis.nodeFacts.some(fact => fact.uses.some(use => use.name === 'input')), 'expression-condition nodes must retain variable-use facts');
const conditionEvaluationModel = analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: functionUnit(functions.get('conditionEvaluationFlow')),
});
const conditionUseNode = conditionEvaluationModel.controlFlowGraph.nodes.find(node => node.kind === 'expression-condition' && node.expression === 'enabled');
const conditionUseBinding = conditionEvaluationModel.flowAnalysis.useBindings.find(item => item.nodeId === conditionUseNode.id && item.name === 'enabled');
assert.equal(conditionUseBinding.resolution, 'reaching-definition', 'short-circuit RHS must see the assignment performed by the LHS condition');
assert.equal(conditionUseBinding.reachingDefinitions.length, 1);
console.log('Data Flow Engine tests passed: CFG/SSA, allocation-site points-to and field loads/stores, points-to-backed Memory SSA, context-sensitive local call effects, SSA-to-Constraint-IR aliases, composed collection index provenance and JSON-safe DataModel.');
