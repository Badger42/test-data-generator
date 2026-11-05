export { createTypeScriptDataFlowAnalyzer } from './data-flow-analyzer.mjs';
export { createDataFlowAnalyzerAdapter } from './data-flow-adapter.mjs';
export { buildSsaGraph } from './ssa/ssa-builder.mjs';
export { analyzeAliases } from './alias/alias-analyzer.mjs';
export { analyzeMutations } from './mutation/mutation-analyzer.mjs';
export { buildFunctionSummaries, collectLocalCallSites } from './summaries/function-summary.mjs';
export { buildControlFlowGraph } from './cfg/control-flow-graph.mjs';
export { buildInterproceduralSummary } from './summaries/interprocedural-summary.mjs';
export { collectReduceFlowSummaries } from './summaries/reduce-flow-summary.mjs';

export { analyzeControlFlowGraph } from './cfg/graph-analysis.mjs';
export { analyzeReachingDefinitions } from './flow/reaching-definitions.mjs';
export { buildArrayPipelineDataFlow } from './arrays/array-pipeline-flow.mjs';
export { buildLoopFlowSummary } from './summaries/loop-flow-summary.mjs';

export { buildCytronSsa } from './ssa/cytron-ssa-builder.mjs';
export { buildHeapMemorySsa } from './ssa/heap-memory-ssa.mjs';

export { analyzePointsTo } from './alias/points-to-analysis.mjs';
export { buildContextSensitiveSummary } from './summaries/context-sensitive-summary.mjs';
