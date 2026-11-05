/** TypeScript-AST-aware helpers for conservative numeric loop progress checks. */
export function createLoopProgressAnalyzer({ ts, unwrap, getLiteral, invertRelationalOperator }) {
  if (!ts || typeof unwrap !== 'function' || typeof getLiteral !== 'function' || typeof invertRelationalOperator !== 'function') {
    throw new TypeError('LoopProgressAnalyzer requires TypeScript, AST unwrap/literal and operator ports.');
  }

  function applyLoopIncrementor(increment, constants) {
    const result = new Map(constants);
    if (!increment) return result;
    const expression = unwrap(increment);
    if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
      if (!ts.isIdentifier(expression.operand) || !result.has(expression.operand.text)) return result;
      const delta = expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : expression.operator === ts.SyntaxKind.MinusMinusToken ? -1 : 0;
      if (delta) result.set(expression.operand.text, result.get(expression.operand.text) + delta);
      return result;
    }
    if (ts.isBinaryExpression(expression) && ts.isIdentifier(expression.left) && result.has(expression.left.text)) {
      const current = result.get(expression.left.text);
      const amount = getLiteral(expression.right);
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && amount.ok && typeof current === 'number' && typeof amount.value === 'number') result.set(expression.left.text, current + amount.value);
      else if (expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken && amount.ok && typeof current === 'number' && typeof amount.value === 'number') result.set(expression.left.text, current - amount.value);
      else if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isBinaryExpression(expression.right)) {
        const right = expression.right;
        const isCounterLeft = ts.isIdentifier(right.left) && right.left.text === expression.left.text;
        const isCounterRight = ts.isIdentifier(right.right) && right.right.text === expression.left.text;
        const other = getLiteral(isCounterLeft ? right.right : isCounterRight ? right.left : right);
        if ((isCounterLeft || isCounterRight) && other.ok && typeof current === 'number' && typeof other.value === 'number') {
          if (right.operatorToken.kind === ts.SyntaxKind.PlusToken) result.set(expression.left.text, current + other.value);
          else if (right.operatorToken.kind === ts.SyntaxKind.MinusToken && isCounterLeft) result.set(expression.left.text, current - other.value);
        }
      }
    }
    return result;
  }

  function applyNumericUpdates(node, constants, result = new Map()) {
    // Only trust unconditional, top-level updates; nested increments may not execute every iteration.
    const statements = ts.isBlock(node) ? node.statements : [node];
    for (const statement of statements) {
      if (!ts.isExpressionStatement(statement)) continue;
      const expression = unwrap(statement.expression);
      if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
        if (ts.isIdentifier(expression.operand) && constants.has(expression.operand.text)) {
          const delta = expression.operator === ts.SyntaxKind.PlusPlusToken ? 1 : expression.operator === ts.SyntaxKind.MinusMinusToken ? -1 : 0;
          if (delta) result.set(expression.operand.text, (result.get(expression.operand.text) ?? constants.get(expression.operand.text)) + delta);
        }
      } else if (ts.isBinaryExpression(expression) && ts.isIdentifier(expression.left) && constants.has(expression.left.text)) {
        const amount = getLiteral(expression.right);
        if (amount.ok && typeof amount.value === 'number') {
          const delta = expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? amount.value :
            expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ? -amount.value : 0;
          if (delta) result.set(expression.left.text, (result.get(expression.left.text) ?? constants.get(expression.left.text)) + delta);
        }
      }
    }
    return result;
  }

  function hasSimpleLoopProgress(statement, variableName) {
    if (!variableName || !statement.incrementor) return false;
    const increment = statement.incrementor;
    if ((ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) &&
        (increment.operator === ts.SyntaxKind.PlusPlusToken || increment.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(increment.operand) && increment.operand.text === variableName) return true;
    if (ts.isBinaryExpression(increment) && ts.isIdentifier(increment.left) && increment.left.text === variableName &&
        [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken].includes(increment.operatorToken.kind) &&
        getLiteral(increment.right).ok && typeof getLiteral(increment.right).value === 'number') return true;
    return false;
  }

  function loopProgressesTowardExit(statement, variableName) {
    if (!hasSimpleLoopProgress(statement, variableName) || !statement.condition) return false;
    const comparison = unwrap(statement.condition);
    if (!ts.isBinaryExpression(comparison)) return false;
    const operator = comparison.operatorToken.kind;
    const variableOnLeft = ts.isIdentifier(unwrap(comparison.left)) && unwrap(comparison.left).text === variableName;
    const variableOnRight = ts.isIdentifier(unwrap(comparison.right)) && unwrap(comparison.right).text === variableName;
    if (!variableOnLeft && !variableOnRight) return false;
    const normalized = variableOnRight ? invertRelationalOperator(operator) : operator;
    const increment = statement.incrementor;
    let direction = 0;
    if ((ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) && ts.isIdentifier(increment.operand)) {
      direction = increment.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1;
    } else if (ts.isBinaryExpression(increment)) {
      const amount = getLiteral(increment.right);
      if (amount.ok && typeof amount.value === 'number') {
        direction = increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? Math.sign(amount.value) : -Math.sign(amount.value);
      }
    }
    return direction > 0 && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(normalized) ||
      direction < 0 && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(normalized);
  }

  function localCounterProgressesTowardExit(condition, body, constants) {
    const comparison = unwrap(condition);
    if (!ts.isBinaryExpression(comparison)) return false;
    const updates = applyNumericUpdates(body, constants);
    for (const [name, initialValue] of constants) {
      const leftIsCounter = ts.isIdentifier(unwrap(comparison.left)) && unwrap(comparison.left).text === name;
      const rightIsCounter = ts.isIdentifier(unwrap(comparison.right)) && unwrap(comparison.right).text === name;
      if (!leftIsCounter && !rightIsCounter) continue;
      const nextValue = updates.get(name);
      if (nextValue === undefined) continue;
      const direction = Math.sign(nextValue - initialValue);
      const operator = rightIsCounter ? invertRelationalOperator(comparison.operatorToken.kind) : comparison.operatorToken.kind;
      if (direction > 0 && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(operator)) return true;
      if (direction < 0 && [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(operator)) return true;
    }
    return false;
  }

  return Object.freeze({ applyLoopIncrementor, applyNumericUpdates, hasSimpleLoopProgress, loopProgressesTowardExit, localCounterProgressesTowardExit });
}
