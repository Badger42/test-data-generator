/** TypeScript-AST utilities shared by front-end Data Flow passes. `ts` is injected. */
export function unwrapExpression(node, ts) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression?.(current)
  )) current = current.expression;
  return current;
}

export function getStableSymbolId(symbol, checker) {
  if (!symbol) return null;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const nameNode = declaration?.name;
  let start = -1;
  try { start = nameNode?.getStart?.() ?? declaration?.getStart?.() ?? -1; } catch { /* synthetic node */ }
  // Symbol IDs are scoped by FunctionDataModel.functionId; omit absolute paths
  // so serialized DataModels remain stable across machines/workspaces.
  return `${start}:${symbol.getName?.() ?? 'anonymous'}`;
}

export function getSourceSpan(node, sourceFile, relativeFile = sourceFile?.fileName ?? 'unknown') {
  if (!node || !sourceFile) return null;
  try {
    const startOffset = node.getStart(sourceFile);
    const endOffset = node.getEnd();
    const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
    const end = sourceFile.getLineAndCharacterOfPosition(endOffset);
    return {
      file: relativeFile,
      startOffset,
      endOffset,
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    };
  } catch {
    return null;
  }
}

export function readStaticPath(node, ts) {
  const current = unwrapExpression(node, ts);
  if (!current) return null;
  if (ts.isIdentifier(current)) return { rootName: current.text, segments: [] };
  if (ts.isPropertyAccessExpression(current)) {
    const parent = readStaticPath(current.expression, ts);
    return parent ? { ...parent, segments: [...parent.segments, current.name.text] } : null;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const argument = unwrapExpression(current.argumentExpression, ts);
    let segment;
    if (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral?.(argument)) segment = argument.text;
    else if (ts.isNumericLiteral(argument)) segment = Number(argument.text);
    else return null;
    const parent = readStaticPath(current.expression, ts);
    return parent ? { ...parent, segments: [...parent.segments, segment] } : null;
  }
  return null;
}

export function collectReferencedPaths(node, ts, checker, options = {}) {
  const paths = new Map();
  const rootNode = node;
  const visit = current => {
    if (!current) return;
    if (current !== rootNode && (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current))) return;

    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      // A call's terminal property is the method name, not a data path. Track
      // the receiver (`items` in `items.push(...)`) as the relevant value.
      const pathNode = ts.isPropertyAccessExpression(current) && ts.isCallExpression(current.parent) && current.parent.expression === current
        ? current.expression : current;
      const path = readStaticPath(pathNode, ts);
      if (path) {
        const rootIdentifier = (() => {
          let item = pathNode;
          while (item && (ts.isPropertyAccessExpression(item) || ts.isElementAccessExpression(item))) item = item.expression;
          return item && ts.isIdentifier(item) ? item : null;
        })();
        const symbol = rootIdentifier ? checker?.getSymbolAtLocation(rootIdentifier) : null;
        const symbolId = getStableSymbolId(symbol, checker);
        const key = JSON.stringify([symbolId ?? path.rootName, path.segments]);
        paths.set(key, {
          rootName: path.rootName,
          segments: path.segments,
          symbolId,
          text: pathNode.getText?.() ?? `${path.rootName}.${path.segments.join('.')}`,
          node: pathNode,
        });
        return;
      }
    }
    if (ts.isIdentifier(current) && current.text !== 'undefined' &&
        !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)) {
      const symbol = checker?.getSymbolAtLocation(current);
      const symbolId = getStableSymbolId(symbol, checker);
      const key = JSON.stringify([symbolId ?? current.text, []]);
      paths.set(key, { rootName: current.text, segments: [], symbolId, text: current.text, node: current });
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...paths.values()].sort((a, b) => a.text.localeCompare(b.text));
}

export function isNestedFunction(node, root, ts) {
  return node !== root && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration?.(node));
}

export function getIdentifierSymbol(node, ts, checker) {
  if (!node || !ts.isIdentifier(node)) return null;
  const symbol = checker?.getSymbolAtLocation(node);
  return symbol ? { symbol, symbolId: getStableSymbolId(symbol, checker), name: node.text } : null;
}
