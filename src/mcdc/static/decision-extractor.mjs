/** TypeScript-AST-aware MC/DC decision and atom extraction. */
export function createMcdcDecisionExtractor({ ts, unwrap = value => value }) {
  function nodeKey(node, sourceFile) {
    const current = unwrap(node);
    return `${current.getStart(sourceFile)}:${current.getEnd()}`;
  }

  function collectAtomicConditions(node, sourceFile, output = []) {
    const current = unwrap(node);
    if (!current) return output;
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
      collectAtomicConditions(current.operand, sourceFile, output);
      return output;
    }
    if (ts.isBinaryExpression(current) && (
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken
    )) {
      collectAtomicConditions(current.left, sourceFile, output);
      collectAtomicConditions(current.right, sourceFile, output);
      return output;
    }
    output.push(current);
    return output;
  }

  function evaluateDecision(node, atomValues, sourceFile) {
    const current = unwrap(node);
    if (!current) return null;
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
      const value = evaluateDecision(current.operand, atomValues, sourceFile);
      return value === null ? null : !value;
    }
    if (ts.isBinaryExpression(current)) {
      const op = current.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const left = evaluateDecision(current.left, atomValues, sourceFile);
        const right = evaluateDecision(current.right, atomValues, sourceFile);
        if (left === null || right === null) return null;
        return op === ts.SyntaxKind.AmpersandAmpersandToken ? left && right : left || right;
      }
    }
    const key = nodeKey(current, sourceFile);
    return atomValues.has(key) ? atomValues.get(key) : null;
  }

  return { nodeKey, collectAtomicConditions, evaluateDecision };
}
