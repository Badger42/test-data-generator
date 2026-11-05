import type {
  AnalysisWarning, BranchTarget, CallbackContext, CoverageObligation,
  DecisionModel, FunctionDataModel, McdcPairProposal, MinimalSuiteResult,
  MockAction, MockBindingFact, ParameterModel, RuntimeTraceSet, ScenarioCase, ScenarioCoverage,
  SourceSpan,
} from './domain.js';
import type { ConstraintExpr, ConstraintIR, ConstraintSolverPort, SolveAllOptions, SolveAllResult, SolveOptions, SolveResult } from './constraints.js';
import type { MockPlan, MockPlannerInput, MockPlannerPort } from './mocks.js';

/** TypeScript-specific types are isolated to project/AST-aware ports. */
export interface TypeScriptProjectSnapshot {
  absoluteFile: string;
  relativeFile: string;
  projectRoot: string;
  relativeFile: string;
  sourceText: string;
  sourceFile: import('typescript').SourceFile;
  program: import('typescript').Program;
  checker: import('typescript').TypeChecker;
  /** Internal project-front-end dependency injection; never passed into the Solver. */
  compilerApi?: typeof import('typescript');
  configFile?: string;
}

export interface FunctionUnit {
  functionId: string;
  name: string;
  sourceSpan: SourceSpan;
  parameters: ParameterModel[];
  /** Internal-only AST reference. Must not escape to domain/solver/reporting. */
  astNode: import('typescript').FunctionLikeDeclaration;
}

export interface ProjectLoadRequest {
  file: string;
  configFile?: string;
}

export interface FunctionSelection {
  name?: string;
  exportPath?: string;
  all?: boolean;
}

export interface ProjectLoader {
  load(request: ProjectLoadRequest): TypeScriptProjectSnapshot;
}

export interface FunctionDiscovery {
  discover(project: TypeScriptProjectSnapshot, selection: FunctionSelection): FunctionUnit[];
}

export interface TypeModelProvider {
  getType(path: string[], functionUnit: FunctionUnit): string | null;
  getDefaultValue(path: string[], functionUnit: FunctionUnit): unknown;
  classify(path: string[], functionUnit: FunctionUnit): 'boolean' | 'number' | 'string' | 'array' | 'object' | 'unknown' | null;
}

/** TypeScript-backed provider used only inside the project/analysis front-end. */
export interface TypeModelLookupContext {
  checker: import('typescript').TypeChecker;
  parameterMap: ReadonlyMap<string, { type: import('typescript').Type; index?: number }>;
  localMockMap: ReadonlyMap<string, { resolvedType?: import('typescript').Type }>;
  location?: import('typescript').Node;
}

export interface TypeScriptTypeModelProvider {
  getType(path: string[], context: TypeModelLookupContext): import('typescript').Type | null;
  getDefaultValue(path: string[], context: TypeModelLookupContext): unknown;
  classify(path: string[], context: TypeModelLookupContext): 'boolean' | 'number' | 'string' | 'array' | 'object' | null;
  getTypeAtPath(path: string[], parameterMap: TypeModelLookupContext['parameterMap'], localMockMap: TypeModelLookupContext['localMockMap'], checker: import('typescript').TypeChecker, location?: import('typescript').Node): import('typescript').Type | null;
  defaultValueForType(type: import('typescript').Type, checker: import('typescript').TypeChecker, location?: import('typescript').Node): unknown;
  classifyType(type: import('typescript').Type | null, checker: import('typescript').TypeChecker): 'boolean' | 'number' | 'string' | 'array' | 'object' | null;
}

/** Function-local alias facts consumed by AST/path-aware analysis. */
export type TypeScriptPathAlias =
  | { kind: 'path'; path: string[] }
  | { kind: 'index'; index: number }
  | { kind: 'key'; value: string }
  | { kind: 'constant'; value: unknown }
  | { kind: 'object'; fields?: Record<string, TypeScriptPathAlias> }
  | { kind: 'computed'; expression?: import('typescript').Expression; aliases?: ReadonlyMap<string, TypeScriptPathAlias> }
  | { kind: 'unknown' };

/** TypeScript AST path operations. Compiler nodes stay inside AST-aware modules. */
export interface TypeScriptPathResolver {
  getPath(node: import('typescript').Node): string[] | null;
  getPathWithAliases(node: import('typescript').Node, aliases?: ReadonlyMap<string, TypeScriptPathAlias>): string[] | null;
  collectLocalPathAliases(functionNode: import('typescript').FunctionLikeDeclaration): Map<string, TypeScriptPathAlias>;
  collectLocalNumericConstants(functionNode: import('typescript').FunctionLikeDeclaration): Map<string, number>;
  getLoopVariableName(initializer: import('typescript').ForInitializer | null): string | null;
  getLoopInitialValue(initializer: import('typescript').ForInitializer | null, variableName: string): { ok: true; value: unknown } | { ok: false };
  findLengthCollectionPath(node: import('typescript').Node | undefined, aliases?: ReadonlyMap<string, TypeScriptPathAlias>): string[] | null;
  substituteKnownAliases<T extends import('typescript').Node>(node: T, aliases: ReadonlyMap<string, TypeScriptPathAlias>, depth?: number): T;
  substituteIdentifier<T extends import('typescript').Node>(node: T, name: string, value: string | number | boolean | null): T;
  substituteIdentifiers<T extends import('typescript').Node>(node: T, replacements: ReadonlyMap<string, string | number | boolean | null>): T;
}

export interface InferredPropertyFact {
  path: string;
  kind: 'boolean' | 'number' | 'string' | 'array' | 'object' | 'sequence' | 'unknown';
  confidence: 'high' | 'medium' | 'heuristic' | 'low';
  evidence: string[];
  priority: number;
}

/** Usage-driven inference over a single function's AST. */
export interface PropertyInferencePort {
  inferPropertyModel(
    functionNode: import('typescript').FunctionLikeDeclaration,
    sourceFile: import('typescript').SourceFile,
    parameterNames: string[],
    initialAliases?: ReadonlyMap<string, TypeScriptPathAlias>,
  ): Map<string, InferredPropertyFact>;
  inferredDefaultForPath(path: string[], inferred: ReadonlyMap<string, InferredPropertyFact>): unknown;
  inferredInfoForPath(path: string[], inferred: ReadonlyMap<string, InferredPropertyFact>): InferredPropertyFact | null;
  buildInferredValue(path: string[], inferred: ReadonlyMap<string, InferredPropertyFact>): unknown;
}

/** TypeScript-aware per-function context. It never crosses into domain or Solver. */
export interface FunctionContextBuildFunction {
  node: import('typescript').FunctionLikeDeclaration;
  functionId?: string;
  name?: string;
}

export interface TypeScriptFunctionContext {
  fn: FunctionContextBuildFunction;
  sourceFile: import('typescript').SourceFile;
  checker: import('typescript').TypeChecker;
  parameterMap: Map<string, { index: number; type: import('typescript').Type; parameter: import('typescript').ParameterDeclaration }>;
  localMockMap: Map<string, { resolvedType?: import('typescript').Type }>;
  mockTemplates: unknown[];
  inferredPaths: Map<string, InferredPropertyFact>;
  inferredProperties: Array<{ path: string; inferredType: string; confidence: string; evidence: string[] }>;
  pathAliases: Map<string, TypeScriptPathAlias>;
  localConstants: Map<string, number>;
  baseArgs: unknown[];
  parameters: Array<{ name: string; type: string; supported: boolean }>;
  expressionFacts: FunctionDataModel['expressionFacts'];
  expressionAliasResolver: (identifier: import('typescript').Identifier) => import('typescript').Expression | null;
  dataFlowModel: FunctionDataModel;
  analysisState?: { dispatch(event: unknown): void };
  branchSeen: Set<string>;
  branchOutcomeSeen: Set<string>;
  arrayCallbackSeen: Set<string>;
  arrayPipelineSeen: Set<string>;
  activeAnalysisMetadata: Record<string, unknown>;
  mcdcDecisionSeen: Set<string>;
  mockBehaviorOverrides: Record<string, unknown>;
  constraintEngine: 'hybrid' | 'legacy';
  coverageExpansion: boolean;
  generateMcdc: boolean;
  maxScenarios: number;
  maxAlternatives: number;
  constraintSolver: ConstraintSolver;
  typeModelProvider: TypeScriptTypeModelProvider;
}

/** @deprecated Use TypeScriptFunctionContext. */
export type FunctionContextAdapterContext = TypeScriptFunctionContext;

export interface FunctionContextBuilderPort {
  createFunctionContext(
    fn: FunctionContextBuildFunction,
    sourceFile: import('typescript').SourceFile,
    checker: import('typescript').TypeChecker,
    maxScenarios: number,
    generateMcdc?: boolean,
    generationOptions?: Record<string, unknown>,
  ): TypeScriptFunctionContext;
}

export interface DataFlowAnalysisInput {
  project: TypeScriptProjectSnapshot;
  functionUnit: FunctionUnit;
  typeModel?: TypeModelProvider;
}

export interface DataFlowAnalyzer {
  analyze(input: DataFlowAnalysisInput): FunctionDataModel;
}

/** Internal TypeScript adapter result; compiler bindings never cross into the Solver. */
export interface DataFlowCompilerBindings {
  expressionAliases: Map<import('typescript').Symbol, import('typescript').Expression>;
  mockBindings: Map<import('typescript').Symbol, { kind: 'mock-call'; localName: string; call: string; awaited: boolean }>;
  expressionFacts: FunctionDataModel['expressionFacts'];
  mockBindingFacts: FunctionDataModel['mockBindingFacts'];
}

export interface TypeScriptDataFlowAnalyzer extends DataFlowAnalyzer {
  analyzeWithCompilerBindings(input: DataFlowAnalysisInput): { dataModel: FunctionDataModel; compilerFacts: DataFlowCompilerBindings };
}

export interface ConstraintCompileInput {
  /** AST expression consumed only by the TypeScript compiler adapter. */
  expression: import('typescript').Expression;
  source?: { file?: string; start?: number; end?: number } | null;
  /** Primitive type hints projected from FunctionDataModel properties. */
  pathTypes?: SolveOptions['pathTypes'];
  /** TypeScript-front-end-only immutable alias resolver; aliases are lowered before IR leaves this adapter. */
  resolveAlias?: (identifier: import('typescript').Identifier) => import('typescript').Expression | null;
  /** Guards numeric `+` against JavaScript string concatenation. */
  isNumericExpression?: (expression: import('typescript').Expression) => boolean;
  /** Only parameters, callback/loop aliases and materializable mock roots may be treated as symbolic leaves. */
  isSymbolicRoot?: (identifier: import('typescript').Identifier) => boolean;
}

export interface ConstraintCompiler {
  compile(input: ConstraintCompileInput): ConstraintIR;
}

/** Solver port is exactly the parser-independent contract implemented in src/solver. */
export interface ConstraintSolver extends ConstraintSolverPort {
  solve(expression: ConstraintIR | ConstraintExpr, options?: SolveOptions): SolveResult;
  solveAll(expression: ConstraintIR | ConstraintExpr, options?: SolveAllOptions): SolveAllResult;
}

export interface FunctionAnalysisInput {
  project: TypeScriptProjectSnapshot;
  functionUnit: FunctionUnit;
  dataModel: FunctionDataModel;
  maxScenarios: number;
  generateMcdc: boolean;
  mockBehaviorOverrides?: Record<string, import('./mocks.js').MockBehaviorOverride>;
}

export interface AnalysisProposal {
  functionId: string;
  branches: BranchTarget[];
  decisions: DecisionModel[];
  mcdcPairs: McdcPairProposal[];
  scenarioProposals: ScenarioProposal[];
  warnings: AnalysisWarning[];
}

export interface ScenarioProposal {
  proposalId: string;
  functionId: string;
  targetRefs: Array<{ branchId?: string; outcome?: boolean | string | number | null; decisionId?: string; conditionId?: string }>;
  constraints: ConstraintExpr[];
  callbackContext?: CallbackContext;
  evidence: AnalysisWarning[];
}

export interface FunctionAnalyzer {
  analyze(input: FunctionAnalysisInput): AnalysisProposal;
}

/** Parser-independent mock planning consumes materialized values and JSON-safe policies. */
export interface MockPlanner extends MockPlannerPort {
  plan(input: MockPlannerInput): MockPlan;
}

export interface ScenarioBuildInput {
  proposal: ScenarioProposal;
  solveResult: SolveResult;
  mockActions: MockAction[];
  existingFingerprints: ReadonlySet<string>;
}

export interface ScenarioBuilder {
  build(input: ScenarioBuildInput): ScenarioCase[];
}

export interface InstrumentationInput {
  project: TypeScriptProjectSnapshot;
  decisions: DecisionModel[];
  outputDirectory: string;
}

export interface InstrumentationResult {
  instrumentedFile: string;
  originalFile: string;
  sourceMapFile?: string;
  runtimeTraceSymbol: string;
  instrumentedDecisionIds: string[];
  skipped: AnalysisWarning[];
}

export interface RuntimeInstrumenter {
  instrument(input: InstrumentationInput): InstrumentationResult;
}

export interface JestRunRequest {
  jestBin?: string;
  workingDirectory: string;
  configFile?: string;
  testFile: string;
  coverageProvider: 'v8' | 'babel';
  coverageDirectory: string;
  runtimeTraceFile: string;
  timeoutMs?: number;
}

export interface JestRunResult {
  status: 'passed' | 'tests-failed' | 'runner-not-found' | 'runner-error' | 'timeout';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  testResultsFile?: string;
  coverageFile?: string;
  runtimeTraceFile?: string;
  warnings: AnalysisWarning[];
}

export interface JestRunner {
  run(request: JestRunRequest): JestRunResult;
}

export interface CoverageReader {
  read(coverageFile: string, sourceFile: string): NormalizedCoverageMap;
}

export interface NormalizedCoverageMap {
  sourceFile: string;
  statements: { covered: number; total: number; pct: number };
  functions: { covered: number; total: number; pct: number };
  branches: { covered: number; total: number; pct: number };
  branchEntries: Array<{ id: string; line: number; column?: number; counters: number[]; kind: string }>;
}

export interface BranchMapper {
  map(input: { targets: BranchTarget[]; coverage: NormalizedCoverageMap }): Array<{
    targetId: string;
    status: 'mapped' | 'ambiguous' | 'unmapped' | 'not-applicable';
    entryId?: string;
    outcomeIndexes?: number[];
    confidence: number;
    evidence: AnalysisWarning[];
  }>;
}

export interface RuntimeMcdcVerifier {
  verify(input: { traceSet: RuntimeTraceSet; pairs: McdcPairProposal[] }): Array<{
    pairId: string;
    status: 'runtime-mcdc-verified' | 'runtime-mcdc-not-verified' | 'runtime-mcdc-incomplete';
    observedFalseCaseId?: string;
    observedTrueCaseId?: string;
    evidence: AnalysisWarning[];
  }>;
}

export interface ScenarioAttributor {
  attribute(input: {
    scenarios: ScenarioCase[];
    run: JestRunResult;
    coverage: NormalizedCoverageMap;
    traceSet: RuntimeTraceSet;
    mapping: ReturnType<BranchMapper['map']>;
  }): ScenarioCoverage[];
}

export interface MinimizationInput {
  scenarios: ScenarioCase[];
  attribution: ScenarioCoverage[];
  obligations: CoverageObligation[];
  exactSearchMaxCandidates: number;
  maxSearchNodes: number;
}

export interface TestSuiteMinimizer {
  minimize(input: MinimizationInput): MinimalSuiteResult;
}

export interface CoverageFeedbackPort {
  run(request: {
    scenarios: ScenarioCase[];
    targets: BranchTarget[];
    decisions: DecisionModel[];
    iterations: number;
    coverageGoalPct: number;
  }): {
    scenarios: ScenarioCase[];
    run: JestRunResult;
    attribution: ScenarioCoverage[];
    warnings: AnalysisWarning[];
  };
}

export interface ReportWriter {
  writeJson(filePath: string, report: unknown): void;
}

export interface ProcessRunner {
  run(command: string, args: string[], options: { cwd: string; timeoutMs?: number }): {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  };
}

export interface ConstraintCompilerPort {
  compile(
    node: import('typescript').Expression,
    options?: Pick<ConstraintCompileInput, 'source' | 'pathTypes' | 'resolveAlias' | 'isNumericExpression' | 'isSymbolicRoot'>,
  ): ConstraintIR;
}

export type { AssignmentMaterializer, ScenarioBuilderPort, ScenarioDeduplicator, ScenarioEvidenceBuilder } from './scenarios.js';
