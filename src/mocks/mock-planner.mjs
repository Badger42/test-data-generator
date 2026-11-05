import { enrichMockPlanWithDataFlow } from './data-flow-mock-enricher.mjs';

/** Coordinates dependency metadata, templates and scenario-specific mock behavior. */
export function createMockPlanner(ports) {
  if (!ports?.dependencyDiscovery || !ports?.templateBuilder || !ports?.statePlanner) {
    throw new TypeError('MockPlanner requires dependencyDiscovery, templateBuilder and statePlanner ports.');
  }

  function discover(input) {
    const bindings = ports.dependencyDiscovery.discoverLocalMockBindings(input);
    const callSites = ports.dependencyDiscovery.discoverCallSites(input);
    const templates = ports.templateBuilder.build({ callSites, checker: input.checker });
    return Object.freeze({ bindings, callSites, templates });
  }

  function plan(input) {
    const base = ports.statePlanner.plan(input);
    return enrichMockPlanWithDataFlow(base, input);
  }



  function toScenarioMocks(mockPlan) {
    const projected = ports.statePlanner.toScenarioMocks(mockPlan);
    return projected.map((item, index) => {
      const action = mockPlan.actions?.[index];
      return {
        ...item,
        ...(action?.inputDependencies ? { inputDependencies: action.inputDependencies } : {}),
        ...(action?.dataFlowEffects ? { dataFlowEffects: action.dataFlowEffects } : {}),
        ...(action?.contextIds ? { contextIds: action.contextIds } : {}),
      };
    });
  }

  return Object.freeze({ discover, plan, toScenarioMocks });
}
