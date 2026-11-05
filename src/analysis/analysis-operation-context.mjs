/**
 * Builds the explicit, per-invocation dependency view used by analysis services.
 * The context is projected into named immutable ports; no opaque compatibility payload
 * crosses the service boundary.
 */
export function createAnalysisOperationContext(context, options = {}) {
  if (!context || typeof context !== 'object') {
    throw new TypeError('Analysis operation context requires a function context.');
  }

  const dispatch = event => options.dispatch?.(context, event);
  const incrementConstraintStat = (key, amount = 1) =>
    options.incrementConstraintStat?.(context, key, amount);
  const recordConstraintFallback = reason =>
    options.recordConstraintFallback?.(context, reason);

  return Object.freeze({
    function: Object.freeze({
      node: context.fn,
      sourceFile: context.sourceFile,
      checker: context.checker,
      typeModelProvider: context.typeModelProvider ?? null,
    }),
    limits: Object.freeze({
      maxScenarios: context.maxScenarios,
      maxAlternatives: context.maxAlternatives,
      coverageExpansion: context.coverageExpansion === true,
      maxMcdcAtoms: options.maxMcdcAtoms,
      maxMcdcCombinations: options.maxMcdcCombinations,
    }),
    constraints: Object.freeze({
      engine: context.constraintEngine === 'legacy' ? 'recursive-ast' : context.constraintEngine,
      solver: context.constraintSolver,
      expressionAliasResolver: context.expressionAliasResolver,
    }),
    paths: Object.freeze({
      parameterMap: context.parameterMap,
      localMockMap: context.localMockMap,
      baseArgs: context.baseArgs,
      pathAliases: context.pathAliases,
      inferredPaths: context.inferredPaths,
      dataFlowModel: context.dataFlowModel ?? null,
      localConstants: context.localConstants,
      typeAtPath: context.typeModelProvider?.getTypeAtPath,
    }),
    arrays: Object.freeze({
      metadata: context.activeAnalysisMetadata,
      callbackSeen: context.arrayCallbackSeen,
      pipelineSeen: context.arrayPipelineSeen,
    }),
    mcdc: Object.freeze({
      enabled: context.generateMcdc,
      seen: context.mcdcDecisionSeen,
    }),
    events: Object.freeze({ dispatch, incrementConstraintStat, recordConstraintFallback }),
  });
}


/**
 * Derives an isolated per-invocation context when an AST adapter changes a
 * path/alias or callback port. Unchanged ports are structurally shared; mutable
 * maps passed in `updates` must be newly allocated by the caller.
 */
export function deriveAnalysisOperationContext(operationContext, updates = {}) {
  if (!operationContext?.function || !operationContext?.paths) {
    throw new TypeError('Cannot derive an invalid AnalysisOperationContext.');
  }
  return Object.freeze({
    ...operationContext,
    ...(updates.limits ? { limits: Object.freeze({ ...operationContext.limits, ...updates.limits }) } : {}),
    ...(updates.constraints ? { constraints: Object.freeze({ ...operationContext.constraints, ...updates.constraints }) } : {}),
    ...(updates.paths ? { paths: Object.freeze({ ...operationContext.paths, ...updates.paths }) } : {}),
    ...(updates.arrays ? { arrays: Object.freeze({ ...operationContext.arrays, ...updates.arrays }) } : {}),
    ...(updates.mcdc ? { mcdc: Object.freeze({ ...operationContext.mcdc, ...updates.mcdc }) } : {}),
    ...(updates.events ? { events: Object.freeze({ ...operationContext.events, ...updates.events }) } : {}),
  });
}
