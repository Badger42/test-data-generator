import type { ConstraintExpr as ConstraintIRExpr, SolveAllResult as ConstraintSolveAllResult, SolveResult as ConstraintSolveResult } from './constraints.js';

/** Stable, JSON-safe domain contracts. No TypeScript compiler, Node.js or Jest types here. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SerializedUndefined = { $undefined: true };
export type SerializedValue = JsonValue | SerializedUndefined;
export type PathSegment = string | number;
export type InferenceConfidence = 'declared' | 'high' | 'medium' | 'heuristic' | 'low';
export type EvidenceSource = 'static-analysis' | 'solver' | 'runtime-trace' | 'istanbul' | 'fallback';
export type EvidenceStatus = 'candidate' | 'observed' | 'verified' | 'ambiguous' | 'unsupported' | 'not-applicable';

export interface SourceSpan {
  file: string;                 // project-relative, canonical path
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
}

export interface Evidence {
  source: EvidenceSource;
  status: EvidenceStatus;
  sourceSpan?: SourceSpan;
  scenarioIds?: string[];
  message?: string;
  confidence?: number;
}

export interface PathRef {
  rootKind: 'parameter' | 'local' | 'mock' | 'callback' | 'accumulator';
  rootName: string;
  segments: PathSegment[];
  canonical: string;
}

export interface PropertyModel {
  path: PathRef;
  kind: 'boolean' | 'number' | 'string' | 'array' | 'object' | 'date' | 'enum' | 'unknown';
  optional?: boolean;
  nullable?: boolean;
  enumValues?: SerializedValue[];
  confidence: InferenceConfidence;
  evidence: string[];
  defaultValue?: SerializedValue;
}

export interface AliasFact {
  alias: string;
  target: PathRef | ObjectProjectionRef | ArrayElementRef;
  sourceSpan: SourceSpan;
  immutable: boolean;
  symbolId?: string;
  relation?: 'must-alias' | 'may-alias';
  confidence?: 'high' | 'medium' | 'low';
  /** Symbol identity of the original root object after alias resolution. */
  targetRootSymbolId?: string | null;
}

export interface ObjectProjectionRef {
  kind: 'object-projection';
  fields: Record<string, PathRef | ObjectProjectionRef | ArrayElementRef>;
}

export interface ArrayElementRef {
  kind: 'array-element';
  collection: PathRef;
  index: number | 'representative';
}

export interface ArrayPipelineStage {
  stageId: string;
  method: 'filter' | 'map' | 'flatMap' | 'flat' | 'sort' | 'toSorted' | 'some' | 'every' | 'find' | 'findIndex' | 'findLast' | 'findLastIndex' | 'forEach' | 'reduce' | string;
  sourceSpan: SourceSpan;
  inputElement: PathRef | ObjectProjectionRef | ArrayElementRef;
  outputElement?: PathRef | ObjectProjectionRef | ArrayElementRef;
  constraints?: CompatibilityConstraintExpr[];
  assumptions?: string[];
  warnings?: string[];
}

export interface ExpressionAliasFact {
  kind: 'immutable-expression';
  alias: string;
  /** Source text retained for diagnostics; executable data is lowered into ConstraintValueExpr. */
  expressionText: string;
  dependencies: string[];
  immutable: true;
  sourceSpan: SourceSpan;
}

export interface MockBindingFact {
  kind: 'mock-call';
  localName: string;
  callExpression: string;
  awaited: boolean;
  sourceSpan: SourceSpan;
}

export interface FunctionDataModel {
  functionId: string;
  parameters: ParameterModel[];
  properties: PropertyModel[];
  aliases: AliasFact[];
  /** JSON-safe summaries of immutable local expression dependencies. */
  expressionFacts?: ExpressionAliasFact[];
  /** Call-site facts; the Solver only sees the lowered result paths. */
  mockBindingFacts?: MockBindingFact[];
  controlFlowGraph?: ControlFlowGraph;
  controlFlowAnalysis?: ControlFlowAnalysis;
  flowAnalysis?: DataFlowFixedPointResult;
  ssa?: SsaGraph;
  /** Allocation-site points-to and bounded field-load/store alias model. */
  pointsTo?: PointsToAnalysis;
  /** Field-sensitive, alias-aware memory SSA with conservative weak updates. */
  memorySsa?: HeapMemorySsaGraph;
  mutations?: MutationFact[];
  functionSummaries?: FunctionSummary[];
  callSites?: FunctionCallSite[];
  interprocedural?: InterproceduralSummaryGraph;
  reduceFlows?: ReduceFlowSummary[];
  loopFlow?: LoopFlowSummary;
  /** Bounded path-sensitive symbolic loop exploration results produced during scenario analysis. */
  loopExecutionPlans?: Array<Record<string, JsonValue>>;
  arrayPipelineFlow?: ArrayPipelineFlowGraph;
  /** Session-owned pipeline analysis merged after callback traversal completes. */
  arrayPipelines: ArrayPipelineSummary[];
  warnings: AnalysisWarning[];
}

export interface ParameterModel {
  name: string;
  index: number;
  displayType: string;
  supported: boolean;
  optional?: boolean;
}

export interface AnalysisWarning {
  code: string;
  message: string;
  nodeId?: string;
  symbolId?: string;
  nodeIds?: string[];
  functionIds?: string[];
  sourceSpan?: SourceSpan;
  severity: 'info' | 'warning' | 'error';
}

export type ComparisonOperator = '===' | '!==' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'instanceof';

export type CompatibilityConstraintExpr =
  | { kind: 'constant'; value: SerializedValue }
  | { kind: 'truthy'; path: PathRef; expected: boolean }
  | { kind: 'comparison'; left: PathRef; operator: ComparisonOperator; right: SerializedValue }
  | { kind: 'path-comparison'; left: PathRef; operator: ComparisonOperator; right: PathRef }
  | { kind: 'typeof'; path: PathRef; expected: string }
  | { kind: 'property-exists'; path: PathRef; expected: boolean }
  | { kind: 'array-length'; path: PathRef; min?: number; max?: number; excluded?: number[] }
  | { kind: 'string-pattern'; path: PathRef; pattern: string; flags?: string; expected: boolean }
  | { kind: 'not'; operand: CompatibilityConstraintExpr }
  | { kind: 'and' | 'or'; left: CompatibilityConstraintExpr; right: CompatibilityConstraintExpr }
  | { kind: 'unsupported'; sourceText: string; reason: string; sourceSpan?: SourceSpan };

/** @deprecated Use CompatibilityConstraintExpr. */
export type LegacyConstraintExpr = CompatibilityConstraintExpr;

export interface AssignmentTarget {
  kind: 'argument' | 'mock-result';
  parameterIndex?: number;
  mockCallId?: string;
  path: PathSegment[];
}

export interface Assignment {
  target: AssignmentTarget;
  value: SerializedValue;
  evidence: Evidence[];
}

export type SolveResult = ConstraintSolveResult;
export type SolveAllResult = ConstraintSolveAllResult;
export type ConstraintExpr = ConstraintIRExpr;

export interface BranchTarget {
  id: string;
  compatibilityId?: string;
  /** @deprecated Use compatibilityId. */
  legacyId?: string;
  functionId: string;
  kind: 'if' | 'ternary' | 'switch' | 'loop' | 'callback' | string;
  sourceSpan: SourceSpan;
  outcomes: BranchOutcome[];
  mapping: CoverageMappingStatus;
}

export interface BranchOutcome {
  value: boolean | string | number | null;
  label?: string;
  candidateScenarioIds: string[];
  evidence: Evidence[];
}

export interface DecisionModel {
  id: string;
  functionId: string;
  expression: string;
  sourceSpan: SourceSpan;
  conditions: AtomicCondition[];
  callbackContext?: CallbackContext;
}

export interface AtomicCondition {
  id: string;
  expression: string;
  sourceSpan: SourceSpan;
  constraint: ConstraintExpr;
}

export interface CallbackContext {
  method: string;
  collection: PathRef;
  iterationIndex?: number;
  parameterNames: string[];
}

export interface McdcPairProposal {
  pairId: string;
  decisionId: string;
  conditionId: string;
  conditionFalseScenarioId: string;
  conditionTrueScenarioId: string;
  expectedValues: Record<string, boolean | 'not-evaluated'>;
  expectedDecisionOutcomes: [boolean, boolean];
  evidence: Evidence[];
}

export interface MockAction {
  callId: string;
  callExpression: string;
  callSiteId?: string;
  behavior: 'mockReturnValue' | 'mockResolvedValue' | 'mockRejectedValue' | 'mockImplementation' | 'sequence' | 'conditional';
  value?: SerializedValue;
  error?: { name: string; message: string };
  sequence?: Array<{ behavior: string; value?: SerializedValue; error?: { name: string; message: string }; handlerId?: string }> ;
  cases?: Array<{ when: { args: SerializedValue[] }; action: { behavior: string; value?: SerializedValue; error?: { name: string; message: string }; handlerId?: string } }> ;
  defaultAction?: { behavior: string; value?: SerializedValue; error?: { name: string; message: string }; handlerId?: string };
  handlerId?: string;
  /** Statically resolved argument dependencies for this scenario-specific mock. */
  inputDependencies?: Array<{ index: number; path: PathSegment[]; expressionText: string; confidence: string }>;
  /** Context-sensitive helper effects associated with the mock call, when available. */
  dataFlowEffects?: Array<Record<string, JsonValue>>;
  contextIds?: string[];
  argumentMatcher?: SerializedValue[];
  evidence: Evidence[];
}

export interface ScenarioTargetRef {
  branchId?: string;
  outcome?: boolean | string | number | null;
  decisionId?: string;
  conditionId?: string;
  pairId?: string;
  side?: 'conditionFalse' | 'conditionTrue';
  sourceSpan?: SourceSpan;
}

export interface ScenarioCase {
  id: string;
  functionId: string;
  arguments: SerializedValue[];
  mocks: MockAction[];
  targets: ScenarioTargetRef[];
  assumptions: string[];
  warnings: AnalysisWarning[];
  evidence?: Evidence[];
  fingerprint: string;
}

export interface RuntimeConditionEvent {
  conditionId: string;
  evaluated: boolean;
  value?: boolean;
  sequence: number;
}

export interface RuntimeDecisionEvent {
  scenarioId: string;
  functionId: string;
  decisionId: string;
  value: boolean;
  conditions: RuntimeConditionEvent[];
  callbackContext?: CallbackContext;
  sequence: number;
}

export interface RuntimeTraceSet {
  schemaVersion: '1.0';
  runId: string;
  events: RuntimeDecisionEvent[];
  instrumentationWarnings: AnalysisWarning[];
}

export type CoverageMappingStatus = 'mapped' | 'ambiguous' | 'unmapped' | 'not-applicable';

export interface CoverageOutcomeObservation {
  branchId: string;
  outcome: boolean | string | number | null;
  counter: number;
  evidence: Evidence[];
}

export interface ScenarioCoverage {
  caseId: string;
  passed: boolean;
  coveredBranchOutcomes: CoverageOutcomeObservation[];
  decisionExecutions: RuntimeDecisionEvent[];
  mcdcPairSides: Array<{ pairId: string; side: 'conditionFalse' | 'conditionTrue'; verified: boolean }>;
}

export interface CoverageObligation {
  id: string;
  kind: 'branch-outcome' | 'mcdc-pair-side' | 'conservative-fallback';
  required: boolean;
  evidence: Evidence[];
}

export interface MinimalSuiteResult {
  status: 'complete' | 'partial' | 'complete-with-conservative-fallbacks' | 'unavailable';
  algorithm: 'branch-and-bound-exact-set-cover' | 'greedy-set-cover' | 'unavailable';
  exactMinimumProven: boolean;
  candidateCaseIds: string[];
  selectedCaseIds: string[];
  removedCaseIds: string[];
  obligations: CoverageObligation[];
  missingObligations: string[];
  searchNodes?: number;
  warnings: AnalysisWarning[];
}

/** Control-flow graph node; expression-condition nodes represent short-circuit evaluation leaves. */
export interface ControlFlowGraphNode {
  id: string;
  kind: string;
  sourceSpan?: SourceSpan | null;
  expression?: string | null;
  text?: string;
  label?: string;
  default?: boolean;
  loopStatementStart?: number | null;
}
export interface ControlFlowGraphEdge {
  from: string;
  to: string;
  kind: 'normal' | 'true' | 'false' | 'body' | 'back' | 'break' | 'continue' | 'return' | 'throw' | 'case' | 'default' | 'fallthrough' | 'unmatched' | 'exception' | 'finally' | string;
  label?: string;
}
export interface ControlFlowGraph {
  schemaVersion: '1.0';
  functionId: string | null;
  granularity: 'statement-and-boolean-expression';
  entry: string;
  exit: string;
  nodes: ControlFlowGraphNode[];
  edges: ControlFlowGraphEdge[];
  diagnostics: AnalysisWarning[];
  limits: { expressionLevelBranches: boolean; expressionOperators: string[]; exceptionOrigins: string; arbitraryLoopUnrolling: boolean; labelledControlTransfers?: boolean; forLoopOperationsSeparated?: boolean };
}
/** Dominance, post-dominance and natural-loop facts derived from a CFG. */
export interface ControlFlowAnalysis {
  schemaVersion: '1.0';
  graphFunctionId: string | null;
  reachableNodeIds: string[];
  unreachableNodeIds: string[];
  nonTerminatingNodeIds: string[];
  predecessors: Record<string, string[]>;
  successors: Record<string, string[]>;
  dominators: Record<string, string[]>;
  immediateDominator: Record<string, string | null>;
  dominanceFrontiers: Record<string, string[]>;
  postDominators: Record<string, string[]>;
  immediatePostDominator: Record<string, string | null>;
  controlDependence: Record<string, string[]>;
  naturalLoops: Array<{ id: string; header: string; latch: string; nodes: string[]; backEdgeKind: string }>;
  convergence: { dominators: boolean; dominatorPasses: number; postDominators: boolean; postDominatorPasses: number };
  diagnostics: AnalysisWarning[];
  limits: Record<string, JsonValue>;
}

export interface DataFlowDefinition {
  id: string;
  symbolId: string;
  name: string;
  kind: string;
  nodeId: string;
  expressionText: string | null;
  sourceSpan: SourceSpan | null;
}
export interface DataFlowNodeFacts {
  nodeId: string;
  definitions: Array<{ symbolId: string; name: string; kind: string; expressionText: string | null; sourceSpan: SourceSpan | null }>;
  uses: Array<{ symbolId: string; name: string }>;
}
export interface DataFlowFixedPointResult {
  schemaVersion: '1.0';
  algorithm: string;
  definitions: DataFlowDefinition[];
  nodeFacts: DataFlowNodeFacts[];
  reachingDefinitions: Record<string, { in: DataFlowDefinition[]; out: DataFlowDefinition[] }>;
  liveIn: Record<string, string[]>;
  liveOut: Record<string, string[]>;
  phiCandidates: Array<{ id: string; symbolId: string; name: string; nodeId: string; inputs: Array<{ predecessor: string; reachingDefinitions: string[] }>; complete: boolean }>;
  useBindings: Array<{ nodeId: string; symbolId: string; name: string; reachingDefinitions: string[]; value: string | null; resolution: string }>;
  diagnostics: AnalysisWarning[];
  convergence: { reachingDefinitions: boolean; reachingPasses: number; liveness: boolean; livenessPasses: number };
  limits: Record<string, JsonValue>;
}

export interface ArrayPipelineSummary {
  id: string;
  sourceLocation: { line: number; column: number };
  sourceExpression: string;
  collection: string;
  representativeIndex: number;
  resultKind: string;
  stages: Array<Record<string, JsonValue>>;
  elementAlias: JsonValue;
  requiredSourceIndexes: number[];
  assumptions: string[];
  warnings: string[];
}
export interface LoopFlowSummary {
  schemaVersion: '1.0';
  loops: Array<{
    id: string; kind: string; header: string; latch: string; nodeIds: string[];
    carriedVariables: Array<{ symbolId: string; name: string; mergeNodeId: string; complete: boolean }>;
    exitEdges: Array<{ from: string; to: string }>;
    breakEdges: Array<{ from: string; to: string }>;
    continueEdges: Array<{ from: string; to: string }>;
    liveOut: string[]; stateTransfer: string; confidence: 'low' | 'medium';
  }>;
  reduceLoops: Array<{ id: string; kind: 'array-reduce'; sourceSpan: SourceSpan | null; accumulator: ReduceFlowSummary['accumulator']; hasAccumulatorRecurrence: boolean; stateful: boolean; effects: ReduceFlowSummary['effects']; executionModel: string; concreteSimulation: boolean; confidence: 'low' | 'medium' }>;
  limits: Record<string, JsonValue>;
}

export interface ArrayPipelineFlowGraph {
  schemaVersion: '1.0' | '1.1';
  pipelines: Array<{
    id: string; sourceExpression: string; collection: string; collectionPath: PathSegment[] | null; resultKind: string;
    stages: Array<Record<string, JsonValue>>;
    edges: Array<{ from: string; to: string; kind: string; composedIndexRelation?: string }>;
    constraints: Array<{ stageId: string; kind: string; expression: string }>;
    sourceMappings: Array<{ sourceIndex: number; outputIndexExpression: string | null; exact: boolean; oneToOne: boolean; excluded: boolean; stageKinds: string[]; sourcePath: PathSegment[] | null; representativeOutputPath: PathSegment[] | null }>;
    elementAlias: JsonValue; assumptions: string[]; warnings: string[];
    provenance: { kind: string; completeForGeneralRuntime: boolean; requiredSourceIndexes: number[]; exactSourceIndexMapping: boolean; symbolicMappings?: number };
  }>;
  pipelineCount: number;
  stageCount: number;
  limits: Record<string, JsonValue>;
}

/** JSON-safe bounded allocation-site points-to analysis. */
export interface PointsToAnalysis {
  schemaVersion: '1.0' | '1.1';
  algorithm: 'bounded-andersen-inclusion-points-to';
  allocations: Array<{ id: string; kind: string; external?: boolean; sourceSpan?: SourceSpan | null }>;
  symbols: Record<string, string>;
  pointsTo: Record<string, string[]>;
  heapFields: Record<string, string[]>;
  /** Symbols whose may-points-to set includes an unmodeled/unknown reference value. */
  unknownSymbols?: string[];
  /** Heap fields widened by an unknown or non-reference store. */
  unknownHeapFields?: string[];
  aliasPairs: Array<{ leftSymbolId: string; rightSymbolId: string; relation: 'must-alias' | 'may-alias'; sharedAllocationSites: string[]; confidence: 'high' | 'medium'; reason: string }>;
  constraints: { copies: number; loads: number; stores: number };
  convergence: { converged: boolean; passes: number; maxPasses: number };
  diagnostics: AnalysisWarning[];
  limits: Record<string, JsonValue>;
}

/** Bounded call-string contexts; unresolved/recursive cases remain conservative. */
export interface ContextSensitiveSummary {
  schemaVersion: '1.0';
  algorithm: 'bounded-context-sensitive-call-string-summary';
  contexts: Array<{
    contextId: string; functionId: string; functionName: string; callId: string; parentContextId: string | null;
    callString: string[]; depth: number;
    argumentBindings: Array<{ parameterIndex: number; parameterName: string; argumentText: string | null; resolvedArgument: string | null; path: PathSegment[] | null; resolved: boolean; origin: string }>;
    directEffects: Array<Record<string, JsonValue>>; transitiveEffects: Array<Record<string, JsonValue>>;
    purity: 'pure' | 'impure' | 'unknown'; returnFacts: Array<Record<string, JsonValue>>;
  }>;
  rootEffects: Array<Record<string, JsonValue>>;
  diagnostics: AnalysisWarning[];
  limits: Record<string, JsonValue>;
}

export interface InterproceduralSummaryGraph {
  schemaVersion: '1.0';
  nodes: Array<{ functionId: string; name: string; purity: 'pure' | 'impure' | 'unknown'; recursive: boolean }>;
  edges: Array<{ from: string; to: string; callee: string; arguments: Array<{ expressionText: string; dependencies: string[] }>; sourceSpan: SourceSpan | null }>;
  components: string[][];
  recursiveComponents: string[][];
  rootCallSites: Array<{ callId: string; targetFunctionId: string; callee: string }>;
  instantiatedCalls?: Array<{ callId: string; functionId: string; callee: string; argumentBindings: Array<{ parameterIndex: number; parameterName: string; argumentText: string | null; argumentPath: PathSegment[] | null; resolved: boolean }>; purity: 'pure' | 'impure' | 'unknown'; effects: Array<Record<string, JsonValue>>; returnValues: Array<Record<string, JsonValue>>; returnModelComplete: boolean }>;
  returnValueFacts?: Array<{ callId: string; targetFunctionId: string; callee: string; values: Array<Record<string, JsonValue>>; complete: boolean; confidence: 'low' | 'high'; usableAsConstraintAlias: boolean }>;
  contextSensitive?: ContextSensitiveSummary;
  rootPurity: 'pure' | 'impure' | 'unknown';
  rootEffects: Array<{ kind: string; path: PathSegment[]; certainty: 'definite' | 'possible'; callId: string | null; targetFunctionId: string | null; propagation?: string; expression?: string }>;
  diagnostics: AnalysisWarning[];
  limits: { expressionInlining: boolean; recursiveExpansion: boolean; effectCertaintyUpgrade: boolean };
  summaries: FunctionSummary[];
}
export interface ReduceFlowSummary {
  id: string;
  collectionExpression: string;
  sourceSpan: SourceSpan | null;
  callbackSourceSpan: SourceSpan | null;
  accumulator: { name: string; parameterIndex: 0 } | null;
  item: { name: string; parameterIndex: 1 } | null;
  index: { name: string; parameterIndex: 2 } | null;
  initialValue: { provided: true; expressionText: string } | { provided: false };
  returns: Array<{ expressionText: string; sourceSpan: SourceSpan | null; dependencies: string[]; dependsOnAccumulator: boolean; dependsOnItem: boolean }>;
  hasAccumulatorRecurrence: boolean;
  stateful: boolean;
  effects: Array<{ kind: string; path: PathSegment[]; certainty: 'definite' | 'possible'; sourceSpan: SourceSpan | null }>;
  confidence: 'low' | 'medium';
  executionModel: 'bounded-callback-interpretation';
  note: string;
}

/** Bounded structural SSA graph cross-linked to the statement/boolean-expression CFG. */
export interface SsaDefinition {
  id: string;
  symbolId: string;
  name: string;
  version: number;
  kind: 'parameter' | 'declaration' | 'assignment' | 'compound-assignment' | 'increment' | 'phi';
  expressionText: string | null;
  dependencies: string[];
  dependsOnVersions: string[];
  blockId: string;
  cfgNodeId?: string | null;
  sourceSpan: SourceSpan | null;
  targetPath?: string;
}
export interface SsaPhiInput { value: string | null; predecessor: string }
export interface SsaPhiNode {
  id: string;
  symbolId: string;
  name: string;
  output: string;
  inputs: SsaPhiInput[];
  sourceSpan: SourceSpan | null;
  cfgNodeId?: string | null;
  kind: 'branch-merge' | 'loop-carried';
}
/** Bounded structural SSA result augmented with CFG-driven reaching-definition and phi-candidate facts. */
export interface VersionedSsaDefinition {
  id: string;
  symbolId: string;
  name: string;
  version: number;
  kind: string;
  nodeId: string;
  cfgNodeId: string;
  expressionText: string | null;
  sourceSpan: SourceSpan | null;
  operands: Array<{ symbolId: string; value: string }>;
  originDefinitionId: string;
}
export interface VersionedSsaPhiInput { predecessor: string; value: string | null; }
export interface VersionedSsaPhiNode {
  id: string; symbolId: string; name: string; version: number; output: string; nodeId: string;
  inputs: VersionedSsaPhiInput[]; sourceSpan: SourceSpan | null;
  kind: 'branch-merge' | 'loop-carried'; complete: boolean;
}
export interface VersionedSsaUseOccurrence { sourceSpan: SourceSpan | null; value: string | null; }
export interface VersionedSsaUseBinding {
  id: string; nodeId: string; symbolId: string; name: string; value: string | null;
  resolution: 'ssa-version' | 'unresolved-before-definition'; reachingDefinitionFacts: string[];
  occurrences?: VersionedSsaUseOccurrence[];
}
export interface VersionedSsaGraph {
  schemaVersion: '1.0'; algorithm: string;
  definitions: VersionedSsaDefinition[]; phiNodes: VersionedSsaPhiNode[]; useBindings: VersionedSsaUseBinding[];
  diagnostics: AnalysisWarning[];
  convergence: { dominatorTreeTraversal: boolean; allReachableNodesVisited: boolean };
  limits: Record<string, JsonValue>;
}
/** Field-sensitive memory SSA produced from alias-normalized property and mutation facts. */
export interface HeapMemorySsaGraph {
  schemaVersion: '1.0'; algorithm: string;
  locations: Array<{ id: string; rootSymbolId: string; rootName: string; path: PathSegment[]; definitionCount: number; readCount: number }>;
  accesses: Array<Record<string, JsonValue>>;
  definitions: VersionedSsaDefinition[];
  phiNodes: VersionedSsaPhiNode[];
  useBindings: VersionedSsaUseBinding[];
  diagnostics: AnalysisWarning[];
  convergence: VersionedSsaGraph['convergence'];
  limits: Record<string, JsonValue>;
  pointsTo?: { aliasPairs: number; propagatedWrites: number; allocationSiteAccesses?: number; algorithm: string } | null;
}
/** Structural compatibility SSA plus fully versioned Cytron SSA facts. */
export interface SsaGraph {
  schemaVersion: '1.0' | '1.1';
  functionId: string | null;
  controlFlowGraph?: { schemaVersion: string; entry: string; exit: string; nodeCount: number; edgeCount: number } | null;
  cfgAware?: { schemaVersion: '1.0' | '1.1'; algorithm: string; definitions: DataFlowDefinition[]; phiNodes: DataFlowFixedPointResult['phiCandidates']; uses: DataFlowFixedPointResult['useBindings']; limits: Record<string, JsonValue> };
  versioned?: VersionedSsaGraph;
  definitions: SsaDefinition[];
  phiNodes: SsaPhiNode[];
  diagnostics: Array<{ code: string; message: string; sourceSpan?: SourceSpan | null }>;
  limits: { maxLoopIterations: number; note: string };
}

export interface MutationFact {
  mutationId: string;
  symbolId: string;
  rootName: string;
  path: PathSegment[];
  expression: string;
  kind: 'property-write' | 'compound-write' | 'increment' | 'delete' | 'known-mutator' | 'unknown-method-effect' | 'escaped-to-call' | 'returned-reference';
  certainty: 'definite' | 'possible';
  aliasesAffected: string[];
  sourceSpan: SourceSpan | null;
  method?: string;
  callee?: string;
}

export interface FunctionSummary {
  functionId: string;
  name: string;
  sourceSpan: SourceSpan | null;
  symbolId?: string | null;
  parameters: Array<{ name: string; index: number; type: string }>;
  returnType: string;
  returns: Array<{ expressionText: string; dependencies: string[]; sourceSpan: SourceSpan | null; value?: Record<string, JsonValue> }>;
  calls: Array<{ callId?: string; callee: string; targetSymbolId?: string | null; sourceSpan: SourceSpan | null; knownPure: boolean; resolvedSummaryId?: string; arguments?: Array<{ expressionText: string; dependencies: string[] }> }>;
  effects: Array<{ kind: string; path: PathSegment[]; certainty: 'definite' | 'possible' }>;
  purity: 'pure' | 'impure' | 'unknown';
  directPurity?: 'pure' | 'impure' | 'unknown';
  recursive?: boolean;
  transitiveEffects?: Array<{ kind: string; path: PathSegment[]; certainty: 'definite' | 'possible'; propagation?: string; expression?: string }>;
  confidence: 'high' | 'medium';
  inlineable: boolean;
  note: string;
}


export interface FunctionCallSite {
  callId: string;
  callee: string;
  targetFunctionId?: string;
  resolution: 'local-summary' | 'external-or-unresolved';
  knownPure?: boolean;
  arguments: Array<{ expressionText: string; dependencies: string[] }>;
  sourceSpan: SourceSpan | null;
}
