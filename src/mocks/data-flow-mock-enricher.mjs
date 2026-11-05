function normalizePath(path) { return Array.isArray(path) ? path.map(String) : []; }

/**
 * Attaches only statically justified dependency/effect evidence to mock actions.
 * It does not invent mock behavior: values still come from solved scenario
 * assignments or explicit user overrides.
 */
export function enrichMockPlanWithDataFlow(plan, input = {}) {
  const model = input.dataFlowModel;
  if (!model) return plan;
  const callSites = new Map((input.callSites ?? []).map(site => [site.callSiteId, site]));
  const mockFacts = new Map((model.mockBindingFacts ?? []).map(fact => [fact.localName, fact]));
  const contexts = model.interprocedural?.contextSensitive?.contexts ?? [];
  const diagnostics = [...(plan.diagnostics ?? [])];

  const actions = (plan.actions ?? []).map(action => {
    const assignment = (input.mockAssignments ?? []).find(item =>
      String(item.binding?.callId ?? item.binding?.call ?? item.binding?.callExpression) === String(action.callId));
    const localName = assignment?.localName;
    const mockFact = localName ? mockFacts.get(localName) : null;
    const callSite = callSites.get(action.callSiteId) ?? (input.callSites ?? []).find(site =>
      site.callExpression === action.callExpression);
    const argumentFacts = callSite?.argumentFacts ?? [];
    const inputPaths = argumentFacts.filter(item => item.path?.length).map(item => ({
      index: item.index, path: normalizePath(item.path), expressionText: item.expressionText,
      confidence: item.confidence ?? 'medium',
    }));
    const relatedContexts = contexts.filter(context => context.callId === action.callSiteId ||
      context.callId === action.callId || context.functionId === callSite?.targetFunctionId);
    const effects = relatedContexts.flatMap(context => (context.transitiveEffects ?? []).map(effect => ({
      kind: effect.kind, path: normalizePath(effect.path), certainty: effect.certainty,
      contextId: context.contextId, callId: context.callId,
    })));
    const evidence = [...(action.evidence ?? [])];
    if (mockFact || callSite) {
      const allArgumentsResolved = argumentFacts.length > 0 && argumentFacts.every(item => item.path?.length || item.kind === 'literal');
      evidence.push({
        source: 'static-analysis',
        status: allArgumentsResolved ? 'candidate' : 'ambiguous',
        confidence: allArgumentsResolved ? 0.85 : 0.45,
        ...(callSite?.sourceSpan ? { sourceSpan: callSite.sourceSpan } : {}),
        message: `Mock ${action.callExpression} is linked to ${inputPaths.length} resolvable input dependency path(s)${effects.length ? ` and ${effects.length} interprocedural effect(s)` : ''}.`,
      });
    }
    if (!inputPaths.length && callSite) {
      diagnostics.push({ code: 'MOCK_INPUT_DEPENDENCIES_UNRESOLVED', severity: 'info',
        message: `Arguments for mock ${action.callExpression} could not be reduced to stable input paths; behavior remains assignment-driven.`,
        ...(callSite.sourceSpan ? { sourceSpan: callSite.sourceSpan } : {}) });
    }
    return {
      ...action,
      ...(inputPaths.length ? { inputDependencies: inputPaths } : {}),
      ...(effects.length ? { dataFlowEffects: effects } : {}),
      ...(relatedContexts.length ? { contextIds: relatedContexts.map(context => context.contextId) } : {}),
      evidence,
    };
  });
  return Object.freeze({ ...plan, actions: Object.freeze(actions.map(item => Object.freeze(item))), diagnostics: Object.freeze(diagnostics) });
}
