/** Builds type-derived suggestions only; templates never configure Jest by themselves. */
export function createMockTemplateBuilder(options = {}) {
  const unionMembers = options.unionMembers ?? (type => [type]);
  const defaultValueForType = options.defaultValueForType ?? (() => null);
  const serialize = options.serialize ?? (value => value);

  function build(input) {
    const templates = [];
    const seen = new Set();
    for (const site of input.callSites ?? []) {
      const siteKey = site.callSiteId ?? site.callExpression;
      if (seen.has(siteKey)) continue;
      seen.add(siteKey);
      const possibleTypes = unionMembers(site.resolvedType).slice(0, 8);
      const resolvedValues = possibleTypes.map(type => defaultValueForType(type, input.checker, site.node));
      templates.push({
        call: site.callExpression,
        callId: site.callId ?? site.callExpression,
        ...(site.callSiteId ? { callSiteId: site.callSiteId } : {}),
        ...(site.sourceSpan ? { sourceSpan: site.sourceSpan } : {}),
        ...(site.classification ? { classification: site.classification } : {}),
        ...(site.mockTarget ? { mockTarget: site.mockTarget } : {}),
        nested: Boolean(site.nested),
        executionContext: site.executionContext ?? 'function-body',
        reachability: site.reachability ?? 'direct-static-call-site',
        callArguments: (site.argumentFacts ?? []).map(fact => ({
          index: fact.index,
          expression: fact.expressionText,
          kind: fact.kind,
          ...(fact.path ? { path: fact.path } : {}),
          ...(Object.prototype.hasOwnProperty.call(fact, 'value') ? { value: serialize(fact.value) } : {}),
          confidence: fact.confidence,
        })),
        mockBehavior: site.isPromise ? 'mockResolvedValue' : 'mockReturnValue',
        returnType: input.checker.typeToString(site.returnType),
        ...(site.isPromise ? { resolvesTo: input.checker.typeToString(site.resolvedType) } : {}),
        suggestedResolvedValues: resolvedValues.map(serialize),
        ...(site.isPromise ? { suggestedRejection: { name: 'Error', message: 'mock error' } } : {}),
        note: site.mockTarget?.support === 'automatic'
          ? 'Static candidate; the Jest adapter can apply this target during coverage-feedback execution.'
          : 'Static candidate; this target requires project Jest setup or manual resolution.',
      });
    }
    return templates;
  }

  return Object.freeze({ build });
}
