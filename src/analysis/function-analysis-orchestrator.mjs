/**
 * Per-function AST/control-flow orchestration and result projection.
 * Concrete TypeScript, solver, mock and scenario operations are supplied by
 * the transitional adapter; this module owns lifecycle order only.
 */
export function createFunctionAnalysisOrchestrator({
  ts,
  createFunctionContext,
  createControlFlowAnalyzer,
  createControlFlowPorts,
  analyzeTernaries,
  createFunctionAnalysisStateStore,
  defaultMaxAlternatives,
}) {
  if (!ts || typeof ts.isBlock !== 'function') throw new TypeError("FunctionAnalysisOrchestrator requires a TypeScript AST adapter.");
  if (typeof defaultMaxAlternatives !== 'function') throw new TypeError("FunctionAnalysisOrchestrator requires 'defaultMaxAlternatives'.");
  for (const [name, value] of Object.entries({
    createFunctionContext,
    createControlFlowAnalyzer,
    createControlFlowPorts,
    analyzeTernaries,
    createFunctionAnalysisStateStore,
  })) {
    if (typeof value !== 'function') throw new TypeError(`FunctionAnalysisOrchestrator requires '${name}'.`);
  }

  function analyzeFunction(fn, sourceFile, checker, maxScenarios, generateMcdc = false, generationOptions = {}) {
    const localAnalysisState = generationOptions.analysisState ? null : createFunctionAnalysisStateStore();
    const scopedOptions = {
      ...generationOptions,
      analysisState: generationOptions.analysisState ?? localAnalysisState.port,
      maxAlternatives: Math.min(512, Math.max(1, Number.isInteger(generationOptions.maxAlternatives)
        ? generationOptions.maxAlternatives : defaultMaxAlternatives())),
    };
    const ctx = createFunctionContext(fn, sourceFile, checker, maxScenarios, generateMcdc, scopedOptions);

    // Every function receives its own traversal instance. The array-callback
    // adapter resolves this instance through ctx rather than a global singleton.
    ctx.controlFlowAnalyzer = createControlFlowAnalyzer(createControlFlowPorts(ctx));
    const initialPath = [{ assignments: new Map(), unsupported: [] }];
    if (ctx.unsupportedParameters?.length) {
      // An unsupported binding pattern makes every positional argument guess
      // unsound for now. Report the boundary and do not emit null-based cases.
      for (const parameter of ctx.unsupportedParameters) {
        ctx.analysisState.dispatch({
          type: 'analysis.unsupported-branch-recorded',
          branch: { branchId: `unsupported-parameter-${parameter.index}`, outcome: 'both', reason: `${parameter.name}: ${parameter.reason}` },
        });
      }
    } else if (fn.body && ts.isBlock(fn.body)) {
      ctx.controlFlowAnalyzer.analyzeStatements(fn.body.statements, initialPath, ctx);
    } else if (fn.body) {
      analyzeTernaries(fn.body, initialPath, ctx);
    }

    const analysis = ctx.analysisState.snapshot();
    const result = {
      name: fn.name,
      parameters: ctx.parameters,
      inferredProperties: ctx.inferredProperties,
      summary: {
        branchOutcomesFound: analysis.branchCount,
        scenariosGenerated: analysis.scenarios.length,
        branchesWithUnsupportedExpressions: analysis.unsupportedBranches.length,
        loopsAnalyzed: analysis.loopCount,
        loopScenariosGenerated: analysis.loopScenariosGenerated,
        ...(generateMcdc ? {
          mcdcDecisionsAnalyzed: analysis.mcdcDecisions.length,
          mcdcConditionsAnalyzed: analysis.mcdcConditions,
          mcdcIndependencePairsFound: analysis.mcdcPairs,
          mcdcConditionsWithoutPair: analysis.mcdcConditionsWithoutPair.length,
        } : {}),
      },
      scenarios: analysis.scenarios,
      ...(ctx.unsupportedParameters?.length ? { unsupportedParameters: ctx.unsupportedParameters } : {}),
      ...(analysis.arrayPipelines.length ? { arrayPipelines: analysis.arrayPipelines } : {}),
      ...(generateMcdc ? { mcdc: {
        criterion: 'unique-cause',
        decisionsAnalyzed: analysis.mcdcDecisions.length,
        conditionsAnalyzed: analysis.mcdcConditions,
        independencePairsFound: analysis.mcdcPairs,
        conditionsWithoutIndependencePair: analysis.mcdcConditionsWithoutPair,
        decisions: analysis.mcdcDecisions,
      } } : {}),
      mockTemplates: ctx.mockTemplates,
      unsupportedBranches: analysis.unsupportedBranches,
    };
    Object.defineProperty(result, '_constraintStats', { value: analysis.constraintStats, enumerable: false });
    Object.defineProperty(result, '_loopExecutionPlans', { value: Object.freeze([...(ctx.dataFlowLoopPlans ?? [])]), enumerable: false });
    return result;
  }

  return Object.freeze({ analyzeFunction });
}
