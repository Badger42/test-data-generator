import { collectReferencedPaths } from './ast-utils.mjs';
import { collectTypescriptExpressionFacts, createExpressionAliasResolver } from './typescript-expression-facts.mjs';
import { buildSsaGraph } from './ssa/ssa-builder.mjs';
import { analyzeAliases } from './alias/alias-analyzer.mjs';
import { analyzeMutations } from './mutation/mutation-analyzer.mjs';
import { buildFunctionSummaries, collectLocalCallSites } from './summaries/function-summary.mjs';
import { buildControlFlowGraph } from './cfg/control-flow-graph.mjs';
import { analyzeControlFlowGraph } from './cfg/graph-analysis.mjs';
import { analyzeReachingDefinitions } from './flow/reaching-definitions.mjs';
import { buildInterproceduralSummary } from './summaries/interprocedural-summary.mjs';
import { collectReduceFlowSummaries } from './summaries/reduce-flow-summary.mjs';
import { buildLoopFlowSummary } from './summaries/loop-flow-summary.mjs';
import { buildCytronSsa } from './ssa/cytron-ssa-builder.mjs';
import { buildHeapMemorySsa } from './ssa/heap-memory-ssa.mjs';
import { analyzePointsTo } from './alias/points-to-analysis.mjs';
import { buildContextSensitiveSummary } from './summaries/context-sensitive-summary.mjs';

const CALLBACK_METHODS = new Set(['forEach', 'map', 'flatMap', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'sort', 'toSorted']);
function parameterRootKind(symbol, ts, rootFunction) {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isParameter(declaration)) return 'local';
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    let initializer = declaration.initializer;
    if (ts.isAwaitExpression(initializer)) initializer = initializer.expression;
    if (ts.isCallExpression(initializer)) return 'mock';
  }
  const owner = declaration.parent;
  if (owner === rootFunction) return 'parameter';
  const call = owner?.parent;
  const method = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text : null;
  if (method && CALLBACK_METHODS.has(method)) {
    return method === 'reduce' && owner.parameters[0] === declaration ? 'accumulator' : 'callback';
  }
  return 'local';
}

function classifyType(type, checker, ts) {
  if (!type) return { kind: 'unknown', optional: false, nullable: false, confidence: 'low' };
  const members = type.isUnion?.() ? type.types : [type];
  const optional = members.some(member => Boolean(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
  const nullable = members.some(member => Boolean(member.flags & ts.TypeFlags.Null));
  const concrete = members.filter(member => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)));
  if (!concrete.length) return { kind: 'unknown', optional, nullable, confidence: 'low' };
  const kinds = new Set(concrete.map(member => {
    if (member.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.NumberLiteral)) return 'number';
    if (member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.StringLiteral)) return 'string';
    if (member.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) return 'boolean';
    if (checker.isArrayType?.(member) || checker.isTupleType?.(member)) return 'array';
    if (member.flags & ts.TypeFlags.Object) return 'object';
    return 'unknown';
  }));
  const kind = kinds.size === 1 ? [...kinds][0] : 'unknown';
  const enumValues = concrete.every(member => member.isStringLiteral?.() || member.isNumberLiteral?.() ||
    (member.flags & (ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Boolean)))
    ? concrete.map(member => member.value).filter(value => ['string', 'number', 'boolean'].includes(typeof value))
    : undefined;
  const confidence = type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? 'low' : 'declared';
  return { kind, optional, nullable, confidence, ...(enumValues?.length ? { enumValues } : {}) };
}

function toPathRef(reference, checker, ts, rootFunction, aliasFacts = []) {
  const rootSymbol = reference.node && ts.isIdentifier(reference.node)
    ? checker?.getSymbolAtLocation(reference.node)
    : (() => {
      let root = reference.node;
      while (root && (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))) root = root.expression;
      return root && ts.isIdentifier(root) ? checker?.getSymbolAtLocation(root) : null;
    })();
  const alias = aliasFacts.find(fact => fact.symbolId && fact.symbolId === reference.symbolId);
  const rootKind = alias?.targetRootKind ?? parameterRootKind(rootSymbol, ts, rootFunction);
  const rootName = alias?.targetPath?.[0] ?? reference.rootName;
  const segments = alias ? [...alias.targetPath.slice(1), ...reference.segments] : reference.segments;
  return {
    rootKind,
    rootName,
    segments,
    canonical: `${rootKind}:${rootName}${segments.map(segment => `.${segment}`).join('')}`,
  };
}

function sourceFileOf(project, functionUnit) {
  return functionUnit.astNode?.getSourceFile?.() ?? project.sourceFile;
}

/**
 * Creates the TypeScript front-end Data Flow engine. Public output is JSON-safe;
 * compiler bindings (symbols/AST nodes) are exposed only through the explicitly
 * named internal method and are consumed by the TypeScript Condition Compiler.
 */
export function createTypeScriptDataFlowAnalyzer(ts) {
  if (!ts) throw new TypeError('TypeScript API must be injected into Data Flow Analyzer.');
  const projectSummaryCache = new WeakMap();

  function analyzeInternal(input) {
    const { project, functionUnit, mockBehaviorOverrides = {} } = input;
    const functionNode = functionUnit.astNode ?? functionUnit.node;
    const sourceFile = sourceFileOf(project, functionUnit);
    const checker = project.checker;
    if (!functionNode || !sourceFile || !checker) throw new TypeError('Data Flow Analyzer requires function AST, source file and TypeChecker.');
    const relativeFile = project.getRelativeFileName?.(sourceFile.fileName) ?? functionUnit.relativeFile ??
      (sourceFile === project.sourceFile ? project.relativeFile : sourceFile.fileName);

    const controlFlowGraph = buildControlFlowGraph(functionNode, ts, sourceFile, { relativeFile, functionId: functionUnit.functionId });
    const controlFlowAnalysis = analyzeControlFlowGraph(controlFlowGraph);
    const flowAnalysis = analyzeReachingDefinitions(controlFlowGraph, controlFlowAnalysis, functionNode, ts, checker, sourceFile, { relativeFile });
    const aliases = analyzeAliases(functionNode, ts, checker, sourceFile, { relativeFile });
    const mutations = analyzeMutations(functionNode, ts, checker, sourceFile, aliases.facts, { relativeFile });
    const pointsTo = analyzePointsTo(functionNode, ts, checker, sourceFile, { relativeFile, functionId: functionUnit.functionId });
    const ssa = buildSsaGraph(functionNode, ts, checker, sourceFile, {
      relativeFile, functionId: functionUnit.functionId, controlFlowGraph,
    });
    ssa.versioned = buildCytronSsa(controlFlowGraph, controlFlowAnalysis, flowAnalysis);
    const memorySsa = buildHeapMemorySsa(functionNode, ts, checker, sourceFile, controlFlowGraph, controlFlowAnalysis, mutations, aliases.facts, { relativeFile, pointsToAnalysis: pointsTo });
    ssa.cfgAware = {
      schemaVersion: '1.1',
      algorithm: 'cfg-reaching-definitions-plus-cytron-dominator-tree-renaming',
      definitions: flowAnalysis.definitions,
      phiNodes: flowAnalysis.phiCandidates,
      uses: flowAnalysis.useBindings,
      limits: { useRenaming: 'cytron-dominator-tree-stack-renaming', heapMemorySsa: 'separate-memorySsa-model' },
    };
    const functionIndex = project.functionIndex ?? null;
    let functionSummaries;
    if (functionIndex && typeof project === 'object') {
      functionSummaries = projectSummaryCache.get(functionIndex);
      if (!functionSummaries) {
        functionSummaries = buildFunctionSummaries(functionNode, ts, checker, sourceFile, mutations, {
          relativeFile, aliasFacts: aliases.facts, projectFunctionIndex: functionIndex,
        });
        projectSummaryCache.set(functionIndex, functionSummaries);
      }
    } else {
      functionSummaries = buildFunctionSummaries(functionNode, ts, checker, sourceFile, mutations, { relativeFile, aliasFacts: aliases.facts });
    }
    const callSites = collectLocalCallSites(functionNode, ts, checker, sourceFile, functionSummaries, { relativeFile, projectFunctionIndex: functionIndex });
    const interproceduralBase = buildInterproceduralSummary(functionSummaries, callSites, mutations);
    const contextSensitive = buildContextSensitiveSummary(interproceduralBase.summaries ?? functionSummaries, callSites, { maxDepth: 2, maxContexts: 64 });
    const interprocedural = Object.freeze({ ...interproceduralBase, contextSensitive });
    const finalizedSummaries = interprocedural.summaries ?? functionSummaries;
    const compilerFacts = collectTypescriptExpressionFacts(functionNode, ts, checker, sourceFile, {
      fileName: relativeFile,
      functionSummaries: finalizedSummaries,
      returnValueFacts: interprocedural.returnValueFacts,
      ssaVersioned: ssa.versioned,
      projectFunctionIndex: functionIndex,
      mockBehaviorOverrides,
      classifyCall: callExpression => functionIndex?.classifyCall(callExpression) ?? { kind: 'external-dependency', confidence: 'low' },
    });
    const reduceFlows = collectReduceFlowSummaries(functionNode, ts, checker, sourceFile, { relativeFile });
    const loopFlow = buildLoopFlowSummary(controlFlowGraph, controlFlowAnalysis, flowAnalysis, reduceFlows);

    const references = collectReferencedPaths(functionNode.body ?? functionNode, ts, checker);
    const properties = [];
    for (const reference of references) {
      let type = null;
      try { type = checker.getTypeAtLocation(reference.node); } catch { /* unresolved symbols are weak evidence */ }
      const classified = classifyType(type, checker, ts);
      const path = toPathRef(reference, checker, ts, functionNode, aliases.facts);
      properties.push({
        path,
        kind: classified.kind,
        optional: classified.optional || undefined,
        nullable: classified.nullable || undefined,
        enumValues: classified.enumValues,
        confidence: classified.confidence,
        evidence: [type ? `TypeScript: ${checker.typeToString(type)}` : 'Type could not be resolved'],
      });
    }

    const dataModel = {
      functionId: functionUnit.functionId,
      parameters: (functionUnit.parameters ?? functionNode.parameters?.map((parameter, index) => ({
        name: parameter.name.getText(sourceFile), index,
        displayType: (() => { try { return checker.typeToString(checker.getTypeAtLocation(parameter)); } catch { return 'unknown'; } })(),
        supported: ts.isIdentifier(parameter.name),
      })) ?? []).map((parameter, index) => ({ ...parameter, index })),
      properties: properties.sort((a, b) => a.path.canonical.localeCompare(b.path.canonical)),
      aliases: aliases.facts.map(fact => ({
        alias: fact.alias,
        target: { rootKind: fact.targetRootKind ?? 'parameter', rootName: fact.targetPath[0], segments: fact.targetPath.slice(1), canonical: `${fact.targetRootKind ?? 'parameter'}:${fact.targetPath[0]}${fact.targetPath.slice(1).map(item => `.${item}`).join('')}` },
        sourceSpan: fact.sourceSpan,
        immutable: fact.immutable,
        symbolId: fact.symbolId,
        relation: fact.relation,
        confidence: fact.confidence,
        targetRootSymbolId: fact.targetRootSymbolId ?? null,
      })),
      expressionFacts: compilerFacts.expressionFacts,
      mockBindingFacts: compilerFacts.mockBindingFacts,
      arrayPipelines: [],
      controlFlowGraph,
      controlFlowAnalysis,
      flowAnalysis,
      ssa,
      memorySsa,
      pointsTo,
      mutations,
      functionSummaries: finalizedSummaries,
      callSites,
      interprocedural,
      reduceFlows,
      loopFlow,
      warnings: [
        ...controlFlowGraph.diagnostics.map(item => ({ ...item, severity: 'warning' })),
        ...controlFlowAnalysis.diagnostics.map(item => ({ ...item })),
        ...flowAnalysis.diagnostics.map(item => ({ ...item })),
        ...ssa.diagnostics.map(item => ({ code: 'SSA_ANALYSIS', message: item.message, severity: 'warning', sourceSpan: item.sourceSpan })),
        ...ssa.versioned.diagnostics.map(item => ({ ...item })),
        ...memorySsa.diagnostics.map(item => ({ ...item })),
        ...interprocedural.diagnostics.map(item => ({ ...item })),
        ...contextSensitive.diagnostics.map(item => ({ ...item })),
        ...pointsTo.diagnostics.map(item => ({ ...item })),
        ...mutations.filter(item => item.certainty === 'possible').map(item => ({
          code: 'POSSIBLE_MUTATION', message: `${item.kind} may affect ${item.expression}.`, severity: 'info', sourceSpan: item.sourceSpan,
        })),
      ],
    };
    return { dataModel, compilerFacts };
  }

  return Object.freeze({
    analyze(input) { return analyzeInternal(input).dataModel; },
    analyzeWithCompilerBindings(input) { return analyzeInternal(input); },
    createAliasResolver(compilerFacts, checker) { return createExpressionAliasResolver(compilerFacts, checker); },
  });
}
