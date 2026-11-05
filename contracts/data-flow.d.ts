/** Data Flow Engine v0.70.0 public DTO contract; compiler objects never cross this boundary. */
export type { ControlFlowGraph, ControlFlowGraphNode, ControlFlowGraphEdge, ControlFlowAnalysis, DataFlowFixedPointResult, LoopFlowSummary, ArrayPipelineFlowGraph, InterproceduralSummaryGraph, ContextSensitiveSummary, PointsToAnalysis, ReduceFlowSummary, ArrayPipelineSummary, VersionedSsaGraph, VersionedSsaDefinition, VersionedSsaPhiNode, VersionedSsaUseOccurrence, VersionedSsaUseBinding, HeapMemorySsaGraph } from './domain.js';

import type { FunctionDataModel, SsaGraph, HeapMemorySsaGraph, PointsToAnalysis, ControlFlowGraph, ControlFlowAnalysis, DataFlowFixedPointResult } from './domain.js';

export interface DataFlowAnalysisResult {
  dataModel: FunctionDataModel;
  /** Internal TypeScript-only compiler bindings; never serialize or pass to Solver. */
  compilerFacts: unknown;
}

export interface DataFlowAnalyzerPort {
  analyze(input: unknown): FunctionDataModel;
  analyzeWithCompilerBindings(input: unknown): DataFlowAnalysisResult;
}

export interface ControlFlowGraphBuilderPort {
  build(input: unknown): FunctionDataModel['controlFlowGraph'];
}

export interface SsaBuilderPort {
  build(input: unknown): SsaGraph;
}
export interface HeapMemorySsaBuilderPort {
  build(input: unknown): HeapMemorySsaGraph;
}

export interface ControlFlowAnalysisPort { analyze(graph: ControlFlowGraph): ControlFlowAnalysis; }
export interface ReachingDefinitionsPort { analyze(input: unknown): DataFlowFixedPointResult; }

export interface PointsToAnalysisPort { analyze(input: unknown): PointsToAnalysis; }
export interface ContextSensitiveSummaryPort { build(input: unknown): NonNullable<FunctionDataModel['interprocedural']>['contextSensitive']; }
