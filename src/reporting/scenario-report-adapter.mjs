/** Projects a domain ScenarioCase into the stable public JSON report shape. */
export function createScenarioReportAdapter() {
  function project(scenario, input = {}) {
    if (!scenario?.id || !scenario?.functionId) throw new TypeError('ScenarioReportAdapter requires a domain ScenarioCase.');
    return {
      id: scenario.id,
      target: input.target ?? {},
      arguments: scenario.arguments ?? [],
      ...(input.mocks?.length ? { mocks: input.mocks } : {}),
      assumptions: scenario.assumptions ?? [],
      unsupported: input.unsupported ?? [],
      ...(input.includeEvidence && scenario.evidence?.length ? { evidence: scenario.evidence } : {}),
    };
  }
  return Object.freeze({ project });
}
