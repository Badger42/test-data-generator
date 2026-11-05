/**
 * Recursive traversal for expression-level branch constructs.
 * Compiler-specific node checks and all analysis effects are injected so this
 * module owns traversal order without owning solver, session or scenario state.
 */
export function createExpressionTraversal({
  ts,
  analyzeMcdcDecision,
  getMcdcDecisionId,
  addScenarios,
  pathWithCondition,
}) {
  for (const [name, value] of Object.entries({ ts, analyzeMcdcDecision, getMcdcDecisionId, addScenarios, pathWithCondition })) {
    if (!value) throw new TypeError(`ExpressionTraversal requires '${name}'.`);
  }

  function analyzeTernaries(node, incoming, ctx) {
    function visit(current, pathSolutions) {
      if (!current) return;
      if (ts.isConditionalExpression(current)) {
        const conditionText = current.condition.getText(ctx.sourceFile);
        analyzeMcdcDecision(current.condition, pathSolutions, ctx, 'ternary', current.condition);
        const runtimeDecisionId = getMcdcDecisionId('ternary', current.condition, ctx.sourceFile);
        addScenarios(ctx, 'ternary', current.condition, conditionText, true, pathSolutions, null, current.condition, { runtimeDecisionId });
        addScenarios(ctx, 'ternary', current.condition, conditionText, false, pathSolutions, null, current.condition, { runtimeDecisionId });
        visit(current.whenTrue, pathWithCondition(pathSolutions, current.condition, true, ctx));
        visit(current.whenFalse, pathWithCondition(pathSolutions, current.condition, false, ctx));
        return;
      }
      ts.forEachChild(current, child => visit(child, pathSolutions));
    }
    visit(node, incoming);
  }

  return Object.freeze({ analyzeTernaries });
}
