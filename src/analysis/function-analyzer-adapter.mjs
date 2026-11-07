/** Compatibility adapter for the still-transitional function analyzer. */
export function createFunctionAnalyzerAdapter(analyzeFunction) {
  if (typeof analyzeFunction !== 'function') throw new TypeError('analyzeFunction callback is required.');
  return Object.freeze({
    analyze(environment) {
      const { project, functionUnit, limits, features } = environment;
      return analyzeFunction(
        functionUnit,
        project.sourceFile,
        project.checker,
        limits.maxScenarios,
        features.generateMcdc,
        {
          constraintEngine: features.constraintEngine,
          mockBehaviorOverrides: features.mockBehaviorOverrides ?? {},
          includeEvidence: features.includeEvidence === true,
          maxAlternatives: limits.maxAlternatives,
          analysisSessionId: environment.sessionId,
          analysisState: environment.analysisState,
          project: environment.project,
          projectFunctionIndex: environment.project?.functionIndex ?? null,
          dataFlowModel: environment.dataFlowModel,
          dataFlowCompilerBindings: environment.dataFlowCompilerBindings,
        },
      );
    },
  });
}
