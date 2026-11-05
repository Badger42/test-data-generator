/** TypeScript AST-aware utilities for safe callback-local expression expansion. */
export function createCallbackExpressionUtils(ts) {
  if (!ts) throw new TypeError('TypeScript API is required.');

function isFunctionLikeCallback(node) {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function isSafeCallbackLocalInitializer(node) {
  let safe = true;
  function visit(current) {
    if (!safe || !current) return;
    if (ts.isCallExpression(current) || ts.isNewExpression(current) || ts.isAwaitExpression(current) ||
        ts.isYieldExpression(current) || ts.isDeleteExpression(current) ||
        ts.isPrefixUnaryExpression(current) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator) ||
        ts.isPostfixUnaryExpression(current) ||
        ts.isBinaryExpression(current) && [
          ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
          ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
        ].includes(current.operatorToken.kind)) {
      safe = false;
      return;
    }
    if (ts.isFunctionLike(current) && current !== node) return;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return safe;
}

function isReplaceableCallbackIdentifier(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if ((ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  return true;
}

function substituteCallbackLocals(expression, locals) {
  if (!expression || !locals?.size) return expression;
  const transformed = ts.transform(expression, [context => root => {
    const visit = current => {
      if (ts.isFunctionLike(current) && current !== root) return current;
      if (ts.isIdentifier(current) && locals.has(current.text) && isReplaceableCallbackIdentifier(current)) {
        // Reuse the original initializer node so source positions remain available
        // to MC/DC condition IDs and diagnostics. The transformed tree is read-only.
        return locals.get(current.text);
      }
      return ts.visitEachChild(current, visit, context);
    };
    return ts.visitNode(root, visit);
  }]);
  const result = transformed.transformed[0];
  transformed.dispose();
  return result;
}

function getCallbackLocalDefinitions(callback) {
  const locals = new Map();
  if (!callback || !ts.isBlock(callback.body)) return locals;
  for (const statement of callback.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declarationList = statement.declarationList;
    // Inline const declarations only. let/var can be reassigned and are left
    // untouched until control-flow-aware reaching-definition analysis exists.
    if (!(declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !isSafeCallbackLocalInitializer(declaration.initializer)) continue;
      locals.set(declaration.name.text, substituteCallbackLocals(declaration.initializer, locals));
    }
  }
  return locals;
}

function expandCallbackLocalVariables(expression, callback) {
  if (!expression || !callback || !ts.isBlock(callback.body)) return expression;
  return substituteCallbackLocals(expression, getCallbackLocalDefinitions(callback));
}

function getCallbackPredicateSourceExpression(callback) {
  if (!callback) return null;
  if (!ts.isBlock(callback.body)) return callback.body;
  // Treat a block as one predicate only when it consists of top-level const
  // setup followed by one direct return. A return nested under if/loop must
  // remain ordinary control flow; flattening it would change callback semantics.
  const statements = [...callback.body.statements];
  const finalStatement = statements[statements.length - 1];
  if (!finalStatement || !ts.isReturnStatement(finalStatement) || !finalStatement.expression) return null;
  if (statements.slice(0, -1).some(statement => !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const))) return null;
  const returns = [];
  function visit(current) {
    if (!current) return;
    if (current !== callback.body && ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current)) { returns.push(current); return; }
    ts.forEachChild(current, visit);
  }
  visit(callback.body);
  return returns.length === 1 ? finalStatement.expression : null;
}

function getCallbackPredicateExpression(callback) {
  const sourceExpression = getCallbackPredicateSourceExpression(callback);
  return sourceExpression ? expandCallbackLocalVariables(sourceExpression, callback) : null;
}

function getNodeText(node, sourceFile) {
  if (!node) return '';
  // Printing is required for transformed expressions: getText() slices the
  // original source range and would hide expanded callback-local variables.
  return ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Expression, node, sourceFile);
}

  return Object.freeze({
    isFunctionLikeCallback, isSafeCallbackLocalInitializer, isReplaceableCallbackIdentifier,
    substituteCallbackLocals, getCallbackLocalDefinitions, expandCallbackLocalVariables,
    getCallbackPredicateSourceExpression, getCallbackPredicateExpression, getNodeText,
  });
}
