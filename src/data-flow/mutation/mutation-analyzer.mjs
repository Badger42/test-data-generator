import { getIdentifierSymbol, getSourceSpan, readStaticPath } from '../ast-utils.mjs';

const MUTATING_METHODS = new Set([
  'copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift',
  'set', 'delete', 'clear', 'add',
]);
function isAssignmentOperator(kind, ts) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function rootIdentifier(node, ts) {
  let current = node;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  return current && ts.isIdentifier(current) ? current : null;
}

function aliasAt(aliasFacts, symbolId, offset) {
  return (aliasFacts ?? []).filter(item => item.symbolId === symbolId && (item.sourceSpan?.startOffset ?? -1) <= offset)
    .sort((a, b) => (b.sourceSpan?.startOffset ?? -1) - (a.sourceSpan?.startOffset ?? -1))[0] ?? null;
}

function pathInfo(node, ts, checker, aliasFacts = []) {
  const path = readStaticPath(node, ts);
  const root = rootIdentifier(node, ts);
  if (!path || !root) return null;
  const info = getIdentifierSymbol(root, ts, checker);
  if (!info) return null;
  const alias = aliasAt(aliasFacts, info.symbolId, node.getStart?.() ?? Number.MAX_SAFE_INTEGER);
  const canonicalPath = alias ? [...alias.targetPath, ...path.segments] : [path.rootName, ...path.segments];
  return { ...info, path: canonicalPath, expression: node.getText?.() ?? path.rootName };
}

/** Detect explicit writes, known mutators, escapes and unknown call effects. */
export function analyzeMutations(functionNode, ts, checker, sourceFile, aliasFacts = [], options = {}) {
  const mutations = [];
  const relativeFile = options.relativeFile ?? sourceFile?.fileName;

  const add = (node, info, kind, certainty = 'definite', detail = {}) => {
    if (!info) return;
    mutations.push({
      mutationId: `mut:${info.symbolId}:${node.getStart?.(sourceFile) ?? mutations.length}`,
      symbolId: info.symbolId,
      rootName: info.name,
      path: info.path,
      expression: info.expression,
      kind,
      certainty,
      aliasesAffected: aliasFacts.filter(alias => alias.targetPath && alias.targetPath.length <= info.path.length && alias.targetPath.every((segment, index) => segment === info.path[index])).map(alias => alias.alias),
      sourceSpan: getSourceSpan(node, sourceFile, relativeFile),
      ...detail,
    });
  };

  const visit = node => {
    if (!node) return;
    if (node !== functionNode && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind, ts)) {
      const info = pathInfo(node.left, ts, checker, aliasFacts);
      const staticPath = readStaticPath(node.left, ts);
      if (info && staticPath?.segments?.length) add(node, info, node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.FirstAssignment ? 'property-write' : 'compound-write');
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const info = pathInfo(node.operand, ts, checker, aliasFacts);
      const staticPath = readStaticPath(node.operand, ts);
      if (info && staticPath?.segments?.length) add(node, info, 'increment');
    } else if (ts.isDeleteExpression(node)) {
      const info = pathInfo(node.expression, ts, checker, aliasFacts);
      const staticPath = readStaticPath(node.expression, ts);
      if (info && staticPath?.segments?.length) add(node, info, 'delete');
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = pathInfo(node.expression.expression, ts, checker, aliasFacts);
      if (receiver && MUTATING_METHODS.has(method)) add(node, receiver, 'known-mutator', 'definite', { method });
      else if (receiver && !['toSorted', 'slice', 'map', 'filter', 'flat', 'flatMap', 'find', 'findIndex', 'some', 'every', 'reduce', 'concat'].includes(method)) {
        add(node, receiver, 'unknown-method-effect', 'possible', { method });
      }
      for (const argument of node.arguments ?? []) {
        const info = pathInfo(argument, ts, checker, aliasFacts);
        if (info && !['string', 'number', 'boolean'].includes(checker?.typeToString?.(checker.getTypeAtLocation(argument)))) {
          add(node, info, 'escaped-to-call', 'possible', { callee: node.expression.getText(sourceFile) });
        }
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      const info = pathInfo(node.expression, ts, checker, aliasFacts);
      const staticPath = readStaticPath(node.expression, ts);
      if (info && staticPath?.segments?.length) add(node, info, 'returned-reference', 'possible');
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);
  return mutations.sort((a, b) => (a.sourceSpan?.startOffset ?? 0) - (b.sourceSpan?.startOffset ?? 0));
}
