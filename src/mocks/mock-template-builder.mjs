/** Builds type-derived suggestions only; templates never configure Jest by themselves. */
export function createMockTemplateBuilder(options = {}) {
  const unionMembers = options.unionMembers ?? (type => [type]);
  const defaultValueForType = options.defaultValueForType ?? (() => null);
  const serialize = options.serialize ?? (value => value);

  function build(input) {
    const templates = [];
    const seen = new Set();
    for (const site of input.callSites ?? []) {
      if (seen.has(site.callExpression)) continue;
      seen.add(site.callExpression);
      const possibleTypes = unionMembers(site.resolvedType).slice(0, 8);
      const resolvedValues = possibleTypes.map(type => defaultValueForType(type, input.checker, site.node));
      templates.push({
        call: site.callExpression,
        returnType: input.checker.typeToString(site.returnType),
        ...(site.isPromise ? { resolvesTo: input.checker.typeToString(site.resolvedType) } : {}),
        suggestedResolvedValues: resolvedValues.map(serialize),
        ...(site.isPromise ? { suggestedRejection: { name: 'Error', message: 'mock error' } } : {}),
        note: 'Template only: associate the appropriate value with the branch scenario when configuring the Jest mock.',
      });
    }
    return templates;
  }

  return Object.freeze({ build });
}
