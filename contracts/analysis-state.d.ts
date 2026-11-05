export type FunctionAnalysisEvent =
  | { type: 'analysis.scenario-added'; scenario: unknown }
  | { type: 'analysis.branch-outcome-observed'; key: string; branchId: string; outcome: unknown }
  | { type: 'analysis.unsupported-branch-recorded'; branch: { branchId: string; outcome: unknown; reason: string } }
  | { type: 'analysis.unsupported-branch-cleared'; branchId: string; outcome: unknown }
  | { type: 'analysis.loop-entered' }
  | { type: 'analysis.loop-scenario-added'; scenario: unknown }
  | { type: 'analysis.mcdc-decision-added'; decision: unknown }
  | { type: 'analysis.mcdc-conditions-counted'; count: number }
  | { type: 'analysis.mcdc-pair-found' }
  | { type: 'analysis.mcdc-condition-without-pair'; condition: unknown }
  | { type: 'analysis.array-pipeline-recorded'; pipeline: { id: string; [key: string]: unknown } }
  | { type: 'analysis.constraint-stat-incremented'; key: 'irAttempts' | 'irSolved' | 'irSolutionCount' | 'irTruncated' | 'mcdcIrSolved'; amount?: number }
  | { type: 'analysis.constraint-mode-set'; mode: 'hybrid' | 'legacy' }
  | { type: 'analysis.constraint-fallback-recorded'; reason: string };

export interface FunctionAnalysisStateSnapshot {
  readonly eventCount: number;
  readonly scenarios: readonly unknown[];
  readonly branchOutcomes: readonly { readonly key: string; readonly branchId: string; readonly outcome: unknown }[];
  readonly branchCount: number;
  readonly unsupportedBranches: readonly { readonly branchId: string; readonly outcome: unknown; readonly reason: string }[];
  readonly loopCount: number;
  readonly loopScenariosGenerated: number;
  readonly mcdcDecisions: readonly unknown[];
  readonly mcdcPairs: number;
  readonly mcdcConditions: number;
  readonly mcdcConditionsWithoutPair: readonly unknown[];
  readonly arrayPipelines: readonly unknown[];
  readonly constraintStats: Readonly<Record<string, unknown>>;
}

export interface FunctionAnalysisStatePort {
  dispatch(event: FunctionAnalysisEvent): number;
  snapshot(): FunctionAnalysisStateSnapshot;
}
