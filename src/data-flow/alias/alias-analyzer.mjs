import { getIdentifierSymbol, getSourceSpan, readStaticPath, unwrapExpression } from '../ast-utils.mjs';

function resolveRootPath(expression, ts, checker, aliases, depth = 0) {
  if (!expression || depth > 12) return null;
  const current = unwrapExpression(expression, ts);
  const path = readStaticPath(current, ts);
  if (!path) return null;
  const root = currentRoot(current, ts);
  const info = root ? getIdentifierSymbol(root, ts, checker) : null;
  if (info && aliases.has(info.symbolId)) {
    const base = aliases.get(info.symbolId);
    return { rootName: base.rootName, segments: [...base.segments, ...path.segments], rootSymbolId: base.rootSymbolId };
  }
  return { ...path, rootSymbolId: info?.symbolId ?? null };
}

function currentRoot(node, ts) {
  let current = node;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  return current && ts.isIdentifier(current) ? current : null;
}

/** Field-sensitive, intraprocedural must-alias extraction for simple assignments. */
function rootKindForSymbol(symbol, ts, rootFunction) {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isParameter(declaration)) {
    const owner = declaration.parent;
    if (owner === rootFunction) return 'parameter';
    const call = owner?.parent;
    const method = call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
    if (method && ['forEach', 'map', 'flatMap', 'filter', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'sort', 'toSorted'].includes(method)) {
      return method === 'reduce' && owner.parameters[0] === declaration ? 'accumulator' : 'callback';
    }
    return 'local';
  }
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
    let initializer = unwrapExpression(declaration.initializer, ts);
    if (initializer && ts.isAwaitExpression(initializer)) initializer = unwrapExpression(initializer.expression, ts);
    if (initializer && ts.isCallExpression(initializer)) return 'mock';
  }
  return 'local';
}

export function analyzeAliases(functionNode, ts, checker, sourceFile, options = {}) {
  const facts = [];
  const symbolPaths = new Map();
  const relativeFile = options.relativeFile ?? sourceFile?.fileName;
  const visit = node => {
    if (!node) return;
    if (node !== functionNode && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const info = getIdentifierSymbol(node.name, ts, checker);
      const path = resolveRootPath(node.initializer, ts, checker, symbolPaths);
      if (info && path) {
        const declarationList = node.parent;
        const immutable = ts.isVariableDeclarationList(declarationList) && Boolean(declarationList.flags & ts.NodeFlags.Const);
        symbolPaths.set(info.symbolId, path);
        facts.push({
          symbolId: info.symbolId,
          alias: info.name,
          targetRootKind: rootKindForSymbol(checker?.getSymbolAtLocation(currentRoot(node.initializer, ts)), ts, functionNode),
          targetPath: [path.rootName, ...path.segments],
          targetRootSymbolId: path.rootSymbolId ?? null,
          target: `${path.rootName}${path.segments.map(segment => `.${segment}`).join('')}`,
          relation: immutable ? 'must-alias' : 'may-alias',
          immutable,
          kind: 'variable-alias',
          sourceSpan: getSourceSpan(node, sourceFile, relativeFile),
          confidence: immutable ? 'high' : 'medium',
        });
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const info = getIdentifierSymbol(node.left, ts, checker);
      const path = resolveRootPath(node.right, ts, checker, symbolPaths);
      if (info && path) {
        symbolPaths.set(info.symbolId, path);
        facts.push({
          symbolId: info.symbolId,
          alias: info.name,
          targetRootKind: rootKindForSymbol(checker?.getSymbolAtLocation(currentRoot(node.right, ts)), ts, functionNode),
          targetPath: [path.rootName, ...path.segments],
          targetRootSymbolId: path.rootSymbolId ?? null,
          target: `${path.rootName}${path.segments.map(segment => `.${segment}`).join('')}`,
          relation: 'may-alias', immutable: false, kind: 'reassignment-alias',
          sourceSpan: getSourceSpan(node, sourceFile, relativeFile), confidence: 'medium',
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);
  return {
    facts: facts.sort((a, b) => (a.sourceSpan?.startOffset ?? 0) - (b.sourceSpan?.startOffset ?? 0)),
    symbolPaths,
  };
}
