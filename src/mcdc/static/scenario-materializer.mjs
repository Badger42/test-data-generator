/** Builds the two scenario payload sides for an MC/DC independence pair. */
export function createMcdcScenarioMaterializer({ cloneValue, applyAssignment, serializeValue }) {
  return function materialize({ solution, context, node, scenarioId, conditionValues, decisionOutcome }) {
    const args = cloneValue(context.baseArgs);
    const mockValues = new Map();
    for (const assignment of solution.assignments.values()) {
      applyAssignment(args, assignment, context.parameterMap, context.localMockMap, context.checker, node, mockValues);
    }
    const normalizedMocks = [...mockValues.values()].map(mock => ({ ...mock, resolvedValue: serializeValue(mock.resolvedValue) }));
    const metadata = context.activeAnalysisMetadata ?? {};
    const callbackContext = metadata.callbackMethod ? {
      method: metadata.callbackMethod,
      ...(metadata.collection ? { collection: metadata.collection } : {}),
      ...(metadata.iterationIndex !== undefined ? { iterationIndex: metadata.iterationIndex } : {}),
      ...(metadata.callbackParameters?.length ? { parameters: metadata.callbackParameters } : {}),
      ...(metadata.arrayPipelineTrace?.length ? { pipeline: metadata.arrayPipelineTrace } : {}),
    } : undefined;
    return {
      id: scenarioId,
      arguments: serializeValue(args),
      ...(normalizedMocks.length ? { mocks: normalizedMocks } : {}),
      ...(callbackContext ? { callbackContext } : {}),
      atomicConditionValues: conditionValues,
      decisionOutcome,
      assumptions: [...solution.assignments.keys()],
    };
  };
}
