import { buildArrayPipelineDataFlow } from './arrays/array-pipeline-flow.mjs';

/** Compose Data Flow analysis with an existing function analyzer without exposing compiler internals to it. */
export function createDataFlowAnalyzerAdapter(dataFlowAnalyzer, downstreamAnalyzer) {
  if (!dataFlowAnalyzer || typeof dataFlowAnalyzer.analyzeWithCompilerBindings !== 'function') {
    throw new TypeError('A DataFlowAnalyzer with analyzeWithCompilerBindings() is required.');
  }
  if (!downstreamAnalyzer || typeof downstreamAnalyzer.analyze !== 'function') {
    throw new TypeError('A downstream analyzer adapter is required.');
  }
  return Object.freeze({
    analyze(environment) {
      const dataFlow = dataFlowAnalyzer.analyzeWithCompilerBindings({
        project: environment.project,
        functionUnit: environment.functionUnit,
        mockBehaviorOverrides: environment.features?.mockBehaviorOverrides ?? {},
      });
      // Keep the analyzer's public DataModel immutable across the legacy
      // compatibility boundary. The transitional engine enriches `properties`
      // with inferred facts, so give it a shallow DTO copy with owned arrays.
      const compatibilityModel = {
        ...dataFlow.dataModel,
        properties: [...(dataFlow.dataModel.properties ?? [])],
        aliases: [...(dataFlow.dataModel.aliases ?? [])],
        warnings: [...(dataFlow.dataModel.warnings ?? [])],
      };
      const result = downstreamAnalyzer.analyze({
        ...environment,
        dataFlowModel: compatibilityModel,
        dataFlowCompilerBindings: dataFlow.compilerFacts,
      });
      if (!result || typeof result !== 'object') return result;

      // Array Callback analysis runs after the front-end DataModel is built.
      // Merge its session-owned pipeline facts back into the completed model
      // without changing the public report schema.
      const analysisSnapshot = environment.analysisState?.snapshot?.();
      const finalizedModel = {
        ...compatibilityModel,
        properties: [...(compatibilityModel.properties ?? [])],
        aliases: [...(compatibilityModel.aliases ?? [])],
        arrayPipelines: [...(analysisSnapshot?.arrayPipelines ?? result.arrayPipelines ?? [])],
        loopExecutionPlans: [...(result._loopExecutionPlans ?? [])],
        warnings: [...(compatibilityModel.warnings ?? [])],
      };
      finalizedModel.arrayPipelineFlow = buildArrayPipelineDataFlow(finalizedModel.arrayPipelines);
      deepFreezeJson(finalizedModel);
      Object.defineProperty(result, '_dataFlowModel', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: finalizedModel,
      });
      return result;
    },
  });
}


function deepFreezeJson(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) deepFreezeJson(value[key], seen);
  return Object.freeze(value);
}
