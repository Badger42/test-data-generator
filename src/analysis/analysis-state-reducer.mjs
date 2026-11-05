/** Pure reducer for facts produced while analyzing one function. */
export function createInitialFunctionAnalysisState() {
  return {
    eventCount: 0,
    scenarios: [],
    branchOutcomes: [],
    branchCount: 0,
    unsupportedBranches: [],
    loopCount: 0,
    loopScenariosGenerated: 0,
    mcdcDecisions: [],
    mcdcPairs: 0,
    mcdcConditions: 0,
    mcdcConditionsWithoutPair: [],
    arrayPipelines: [],
    constraintStats: {
      mode: 'hybrid',
      irAttempts: 0,
      irSolved: 0,
      irSolutionCount: 0,
      irTruncated: 0,
      mcdcIrSolved: 0,
      legacyFallback: 0,
      fallbackReasons: {},
    },
  };
}


export function reduceFunctionAnalysisState(state, event) {
  if (!event || typeof event.type !== 'string') throw new TypeError('Analysis state event requires a type.');
  const next = { ...state, eventCount: state.eventCount + 1 };
  switch (event.type) {
    case 'analysis.scenario-added':
      next.scenarios = [...state.scenarios, event.scenario];
      return next;
    case 'analysis.branch-outcome-observed': {
      if (state.branchOutcomes.some(item => item.key === event.key)) return next;
      next.branchOutcomes = [...state.branchOutcomes, { key: event.key, branchId: event.branchId, outcome: event.outcome }];
      next.branchCount = state.branchCount + 1;
      return next;
    }
    case 'analysis.unsupported-branch-recorded':
      next.unsupportedBranches = [...state.unsupportedBranches, event.branch];
      return next;
    case 'analysis.unsupported-branch-cleared':
      next.unsupportedBranches = state.unsupportedBranches.filter(item =>
        !(item.branchId === event.branchId && item.outcome === event.outcome));
      return next;
    case 'analysis.loop-entered':
      next.loopCount = state.loopCount + 1;
      return next;
    case 'analysis.loop-scenario-added':
      next.scenarios = [...state.scenarios, event.scenario];
      next.loopScenariosGenerated = state.loopScenariosGenerated + 1;
      return next;
    case 'analysis.mcdc-decision-added':
      next.mcdcDecisions = [...state.mcdcDecisions, event.decision];
      return next;
    case 'analysis.mcdc-conditions-counted':
      next.mcdcConditions = state.mcdcConditions + event.count;
      return next;
    case 'analysis.mcdc-pair-found':
      next.mcdcPairs = state.mcdcPairs + 1;
      return next;
    case 'analysis.mcdc-condition-without-pair':
      next.mcdcConditionsWithoutPair = [...state.mcdcConditionsWithoutPair, event.condition];
      return next;
    case 'analysis.array-pipeline-recorded': {
      const index = state.arrayPipelines.findIndex(item => item.id === event.pipeline.id);
      next.arrayPipelines = index < 0
        ? [...state.arrayPipelines, event.pipeline]
        : state.arrayPipelines.map((item, current) => current === index ? event.pipeline : item);
      return next;
    }
    case 'analysis.constraint-stat-incremented': {
      const stats = { ...state.constraintStats };
      const key = event.key;
      if (key === 'fallbackReasons') throw new Error('Use analysis.constraint-fallback-recorded for fallback reasons.');
      if (typeof stats[key] !== 'number') throw new Error(`Unknown numeric constraint statistic '${key}'.`);
      stats[key] += event.amount ?? 1;
      next.constraintStats = stats;
      return next;
    }
    case 'analysis.constraint-mode-set':
      next.constraintStats = { ...state.constraintStats, mode: event.mode };
      return next;
    case 'analysis.constraint-fallback-recorded': {
      const reason = String(event.reason || 'IR solver did not produce a usable assignment');
      const fallbackReasons = { ...state.constraintStats.fallbackReasons, [reason]: (state.constraintStats.fallbackReasons[reason] ?? 0) + 1 };
      next.constraintStats = {
        ...state.constraintStats,
        legacyFallback: state.constraintStats.legacyFallback + 1,
        fallbackReasons,
      };
      return next;
    }
    default:
      throw new Error(`Unknown function analysis event '${event.type}'.`);
  }
}
