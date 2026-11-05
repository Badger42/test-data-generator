import { collectReferencedPaths, getSourceSpan, getStableSymbolId, readStaticPath, unwrapExpression } from '../ast-utils.mjs';
import { analyzeAliases } from '../alias/alias-analyzer.mjs';
import { analyzeMutations } from '../mutation/mutation-analyzer.mjs';

const PURE_INTRINSICS = new Set([
  'Math.abs', 'Math.ceil', 'Math.floor', 'Math.max', 'Math.min', 'Math.round',
  'Math.trunc', 'Number.isFinite', 'Number.isInteger', 'Number.isNaN',
  'String', 'Boolean', 'Number',
]);

function isFunctionLike(node, ts) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration?.(node);
}

function functionName(node, ts, fallback) {
  if (node.name) return node.name.getText?.() ?? node.name.text ?? fallback;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return fallback;
}


function isNestedWithin(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function indexSummariesBySymbol(summaries) {
  return new Map(summaries.filter(summary => summary.symbolId).map(summary => [summary.symbolId, summary]));
}

function functionSymbolId(node, ts, checker, projectFunctionIndex) {
  return projectFunctionIndex?.symbolIdForNode(node) ?? (() => {
    const nameNode = node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : null);
    return nameNode && ts.isIdentifier(nameNode) ? getStableSymbolId(checker?.getSymbolAtLocation(nameNode), checker) : null;
  })();
}

function callSymbolId(expression, checker, projectFunctionIndex) {
  return projectFunctionIndex?.symbolIdForCall(expression) ?? getStableSymbolId(checker?.getSymbolAtLocation(expression), checker);
}

function returnValue(expression, ts, sourceFile) {
  const current = unwrapExpression(expression, ts);
  const path = readStaticPath(current, ts);
  if (path) return { kind: 'path', rootName: path.rootName, segments: path.segments };
  if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral?.(current)) return { kind: 'constant', value: current.text };
  if (ts.isNumericLiteral(current)) return { kind: 'constant', value: Number(current.text) };
  if (current.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'constant', value: true };
  if (current.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'constant', value: false };
  if (current.kind === ts.SyntaxKind.NullKeyword) return { kind: 'constant', value: null };
  if (ts.isPrefixUnaryExpression(current) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(current.operator) && ts.isNumericLiteral(current.operand)) {
    return { kind: 'constant', value: Number(`${current.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${current.operand.text}`) };
  }
  return { kind: 'expression', expressionText: current.getText(sourceFile) };
}

function collectReturns(node, root, ts, checker, sourceFile, relativeFile) {
  const returns = [];
  const visit = current => {
    if (!current) return;
    if (current !== root && isFunctionLike(current, ts)) return;
    if (ts.isReturnStatement(current) && current.expression) {
      returns.push({
        expressionText: current.expression.getText(sourceFile),
        value: returnValue(current.expression, ts, sourceFile),
        dependencies: collectReferencedPaths(current.expression, ts, checker).map(item => item.text),
        sourceSpan: getSourceSpan(current.expression, sourceFile, relativeFile),
      });
      return;
    }
    ts.forEachChild(current, visit);
  };
  if (root.body && ts.isBlock(root.body)) visit(root.body);
  else if (root.body) returns.push({
    expressionText: root.body.getText(sourceFile),
    value: returnValue(root.body, ts, sourceFile),
    dependencies: collectReferencedPaths(root.body, ts, checker).map(item => item.text),
    sourceSpan: getSourceSpan(root.body, sourceFile, relativeFile),
  });
  return returns;
}

function collectCalls(node, root, ts, checker, sourceFile, relativeFile, projectFunctionIndex) {
  const calls = [];
  const visit = current => {
    if (!current) return;
    if (current !== root && isFunctionLike(current, ts)) return;
    if (ts.isCallExpression(current)) calls.push({
      // Offsets are only unique within a source file; include the module path.
      callId: `call:${relativeFile}:${current.getStart(sourceFile)}`,
      callee: current.expression.getText(sourceFile),
      targetSymbolId: callSymbolId(current.expression, checker, projectFunctionIndex),
      arguments: current.arguments.map(argument => ({
        expressionText: argument.getText(sourceFile),
        dependencies: collectReferencedPaths(argument, ts, checker).map(item => item.text),
      })),
      sourceSpan: getSourceSpan(current, sourceFile, relativeFile),
      knownPure: PURE_INTRINSICS.has(current.expression.getText(sourceFile)),
    });
    ts.forEachChild(current, visit);
  };
  if (root.body) visit(root.body);
  return calls;
}

/**
 * Builds JSON-safe summaries for project functions and nested local helpers.
 * Every AST node is analyzed against its own SourceFile, TypeChecker symbol and
 * project-relative path. Without a project index, the historical per-function
 * nested-helper behavior is retained for embedders and isolated unit tests.
 */
export function buildFunctionSummaries(functionNode, ts, checker, sourceFile, _mutations = [], options = {}) {
  const projectFunctionIndex = options.projectFunctionIndex;
  const candidates = [];
  const seenNodes = new Set();
  const addCandidate = (node, entry = null) => {
    if (!node || seenNodes.has(node)) return;
    seenNodes.add(node);
    candidates.push({ node, entry });
  };

  if (projectFunctionIndex?.entries?.length) {
    for (const entry of projectFunctionIndex.entries) addCandidate(entry.node, entry);
  } else {
    const visit = node => {
      if (!node) return;
      if (node !== functionNode && isFunctionLike(node, ts)) {
        addCandidate(node);
        ts.forEachChild(node, visit);
        return;
      }
      ts.forEachChild(node, visit);
    };
    if (functionNode?.body) visit(functionNode.body);
  }

  const summaries = [];
  for (const [index, candidate] of candidates.entries()) {
    const node = candidate.node;
    const nodeSourceFile = node.getSourceFile?.() ?? candidate.entry?.sourceFile ?? sourceFile;
    const relativeFile = candidate.entry?.relativeFile ?? projectFunctionIndex?.getRelativeFileName?.(nodeSourceFile.fileName) ?? options.relativeFile ?? nodeSourceFile.fileName;
    const span = getSourceSpan(node, nodeSourceFile, relativeFile);
    const name = candidate.entry?.name ?? functionName(node, ts, `anonymous_${index + 1}`);
    const start = span?.startOffset ?? index;
    const localAliases = analyzeAliases(node, ts, checker, nodeSourceFile, { relativeFile });
    // Nested helpers may close over aliases established in their containing
    // function. Preserve those lexical facts when both nodes belong to the
    // same source file; never leak the selected root's aliases into imported
    // modules or unrelated project functions.
    const inheritedAliases = nodeSourceFile === sourceFile && isNestedWithin(node, functionNode)
      ? (options.aliasFacts ?? []) : [];
    const aliasesByIdentity = new Map();
    for (const alias of [...inheritedAliases, ...localAliases.facts]) {
      aliasesByIdentity.set(`${alias.symbolId}:${alias.sourceSpan?.startOffset ?? -1}`, alias);
    }
    const effectiveAliasFacts = [...aliasesByIdentity.values()];
    const localMutations = analyzeMutations(node, ts, checker, nodeSourceFile, effectiveAliasFacts, { relativeFile });
    const calls = collectCalls(node, node, ts, checker, nodeSourceFile, relativeFile, projectFunctionIndex);
    const returns = collectReturns(node, node, ts, checker, nodeSourceFile, relativeFile);
    const hasUnknownCalls = calls.some(call => !call.knownPure);
    const hasWrites = localMutations.some(item => !['returned-reference'].includes(item.kind));
    const purity = hasWrites ? 'impure' : hasUnknownCalls ? 'unknown' : 'pure';
    let returnType = 'unknown';
    try { returnType = checker.typeToString(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(node))); }
    catch { /* Incomplete JS signatures remain unknown. */ }
    summaries.push({
      functionId: candidate.entry?.functionId ?? `${relativeFile}::${name}@${start}`,
      symbolId: candidate.entry?.symbolId ?? functionSymbolId(node, ts, checker, projectFunctionIndex),
      name,
      sourceSpan: span,
      parameters: (node.parameters ?? []).map((parameter, parameterIndex) => ({
        name: parameter.name.getText(nodeSourceFile), index: parameterIndex,
        type: (() => { try { return checker.typeToString(checker.getTypeAtLocation(parameter)); } catch { return 'unknown'; } })(),
      })),
      returnType,
      returns,
      calls,
      effects: localMutations.map(item => ({ kind: item.kind, path: item.path, certainty: item.certainty })),
      purity,
      confidence: purity === 'pure' && returns.length ? 'high' : 'medium',
      inlineable: false,
      note: 'Summary is descriptive only. Call expansion requires a separately validated pure-call compiler contract.',
    });
  }

  const summaryBySymbol = indexSummariesBySymbol(summaries);
  for (const summary of summaries) {
    summary.calls = summary.calls.map(call => {
      const target = call.targetSymbolId ? summaryBySymbol.get(call.targetSymbolId) : null;
      return target ? { ...call, resolvedSummaryId: target.functionId } : call;
    });
    const hasWrites = summary.effects.some(item => !['returned-reference'].includes(item.kind));
    const hasUnresolvedCalls = summary.calls.some(call => !call.knownPure && !call.resolvedSummaryId);
    summary.purity = hasWrites ? 'impure' : hasUnresolvedCalls ? 'unknown' : 'pure';
  }
  return summaries;
}

/** Call-site index for direct calls in the selected function body. */
export function collectLocalCallSites(functionNode, ts, checker, sourceFile, summaries = [], options = {}) {
  const summaryBySymbol = indexSummariesBySymbol(summaries);
  const projectFunctionIndex = options.projectFunctionIndex;
  const sites = [];
  const visit = node => {
    if (!node) return;
    if (node !== functionNode && isFunctionLike(node, ts)) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      const targetSymbolId = callSymbolId(node.expression, checker, projectFunctionIndex);
      const target = targetSymbolId ? summaryBySymbol.get(targetSymbolId) : null;
      sites.push({
        // Preserve the legacy local ID for expression-fact correlation.
        callId: `call:${node.getStart(sourceFile)}`,
        callee,
        targetSymbolId,
        ...(target ? { targetFunctionId: target.functionId } : {}),
        resolution: target ? 'local-summary' : 'external-or-unresolved',
        knownPure: PURE_INTRINSICS.has(callee),
        arguments: node.arguments.map(argument => ({
          expressionText: argument.getText(sourceFile),
          dependencies: collectReferencedPaths(argument, ts, checker).map(item => item.text),
        })),
        sourceSpan: getSourceSpan(node, sourceFile, options.relativeFile ?? sourceFile.fileName),
      });
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode.body) visit(functionNode.body);
  return sites;
}
