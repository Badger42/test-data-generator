import type { AnalysisWarning, Evidence, MockAction, MockBindingFact, MockTarget, SerializedValue, SourceSpan } from './domain.js';

export type MockBehavior =
  | 'mockReturnValue'
  | 'mockResolvedValue'
  | 'mockRejectedValue'
  | 'mockImplementation';

export interface MockCallArgumentFact {
  index: number;
  kind: string;
  expressionText: string;
  path?: string[];
  value?: SerializedValue;
  confidence?: string;
}

export interface MockCallClassification {
  kind: 'project-function' | 'project-unindexed' | 'external-dependency' | 'builtin-intrinsic' | 'builtin-opaque' | 'pure-intrinsic' | 'unresolved' | string;
  confidence?: string;
  source?: string;
  symbolName?: string;
  targetFunctionId?: string;
  symbolId?: string;
}

export interface MockCallSite {
  callId: string;
  callExpression: string;
  callSiteId: string;
  returnType: unknown;
  resolvedType: unknown;
  isPromise: boolean;
  node?: import('typescript').CallExpression;
  sourceSpan: SourceSpan;
  classification?: MockCallClassification;
  nested?: boolean;
  functionScope?: string;
  executionContext?: 'function-body' | 'nested-function-body' | string;
  reachability?: 'direct-static-call-site' | 'nested-invocation-not-proven' | string;
  argumentFacts?: MockCallArgumentFact[];
  executionGuards?: Array<{
    kind: 'if' | 'conditional' | 'fallthrough';
    expressionNode: import('typescript').Expression;
    expressionText: string;
    startOffset: number;
    endOffset: number;
    expected: boolean;
  }>;
  invocationStatus?: 'not-invoked' | 'conditional-or-reachable' | 'nested-invocation-not-proven';
  mockTarget?: MockTarget;
  mockExcluded?: boolean;
  mockExclusion?: { kind: 'service' | 'library' | 'method'; pattern: string; call?: string; service?: string; module?: string };
}

/** Transitional compiler-side binding. TypeScript types must not cross into MockPlan. */
export interface MockDependencyBinding {
  localName: string;
  call: string;
  callId: string;
  callExpression: string;
  callSiteId: string;
  mockTarget?: MockTarget;
  directExpression?: boolean;
  resolvedType?: unknown;
  isPromise: boolean;
  awaited: boolean;
  sourceSpan?: SourceSpan;
}

export interface MaterializedMockAssignment {
  localName: string;
  binding: MockDependencyBinding;
  value: SerializedValue;
}

export type MockPlanStep =
  | { behavior: 'mockReturnValue' | 'mockResolvedValue'; value: SerializedValue }
  | { behavior: 'mockRejectedValue'; error: { name: string; message: string } }
  | { behavior: 'mockImplementation'; handlerId: string };

export interface MockPlanAction {
  callId: string;
  callExpression: string;
  callSiteId?: string | null;
  mockTarget?: MockTarget;
  behavior: MockBehavior | 'sequence' | 'conditional';
  value?: SerializedValue;
  error?: { name: string; message: string };
  sequence?: MockPlanStep[];
  cases?: Array<{ when: { args: SerializedValue[] }; action: MockPlanStep }>;
  defaultAction?: MockPlanStep;
  handlerId?: string;
  evidence: Evidence[];
  inputDependencies?: Array<{ index: number; path: string[]; expressionText: string; confidence: string }> ;
  dataFlowEffects?: Array<Record<string, import('./domain.js').JsonValue>>;
  contextIds?: string[];
}

export interface MockPlan {
  version: 1;
  actions: MockPlanAction[];
  diagnostics: AnalysisWarning[];
}

export interface MockBehaviorOverride {
  behavior: MockBehavior | 'sequence' | 'conditional';
  value?: SerializedValue;
  error?: { name: string; message: string };
  handlerId?: string;
  sequence?: MockPlanStep[];
  cases?: Array<{ when: { args: SerializedValue[] }; action: MockPlanStep }>;
  default?: MockPlanStep;
}

export interface MockPlannerInput {
  mockAssignments: MaterializedMockAssignment[];
  behaviorOverrides?: Record<string, MockBehaviorOverride>;
  dataFlowModel?: import('./domain.js').FunctionDataModel;
  callSites?: Array<{ callSiteId: string; callExpression: string; argumentFacts?: Array<{ index: number; kind: string; expressionText: string; path?: string[]; confidence?: string }> }> ;
}

export interface MockPlannerPort {
  plan(input: MockPlannerInput): MockPlan;
  toScenarioMocks(plan: MockPlan): MockAction[];
}

export interface DependencyDiscoveryPort {
  discoverLocalMockBindings(input: {
    functionNode: import('typescript').FunctionLikeDeclaration;
    checker: import('typescript').TypeChecker;
    sourceFile: import('typescript').SourceFile;
    unwrap?: (node: import('typescript').Expression) => import('typescript').Expression;
    relativeFile?: string;
    mockExclusions?: { services?: string[]; libraries?: string[]; methods?: string[] };
  }): Map<string, MockDependencyBinding>;
  discoverCallSites(input: {
    functionNode: import('typescript').FunctionLikeDeclaration;
    checker: import('typescript').TypeChecker;
    sourceFile: import('typescript').SourceFile;
    relativeFile?: string;
    mockExclusions?: { services?: string[]; libraries?: string[]; methods?: string[] };
  }): MockCallSite[];
}

export interface MockTemplateBuilderPort {
  build(input: { callSites: MockCallSite[]; checker: import('typescript').TypeChecker }): Array<Record<string, unknown>>;
}

export interface JestMockFunction {
  mockReturnValue(value: unknown): unknown;
  mockResolvedValue(value: unknown): unknown;
  mockRejectedValue(value: unknown): unknown;
  mockImplementation(implementation: (...args: unknown[]) => unknown): unknown;
  mockReturnValueOnce?(value: unknown): unknown;
  mockResolvedValueOnce?(value: unknown): unknown;
  mockRejectedValueOnce?(value: unknown): unknown;
  mockImplementationOnce?(implementation: (...args: unknown[]) => unknown): unknown;
}

export interface JestMockAdapterPort {
  prepare(
    targets: MockTarget[],
    jestApi: Record<string, unknown>,
    options?: { resolveModule?: (specifier: string, target: MockTarget) => string | null },
  ): Promise<{
    preparedModules: number;
    preparedTargets: string[];
    unpreparedTargets: string[];
    diagnostics: Array<Record<string, unknown>>;
    requiresManualSetup: boolean;
  }>;
  apply(plan: MockPlan, registry: ReadonlyMap<string, JestMockFunction> | Record<string, JestMockFunction>): { applied: string[] };
  applyScenario(
    mocks: MockAction[], args: unknown[], targetReceiver: unknown, jestApi: Record<string, unknown>,
  ): { applied: string[]; appliedTargetIds: string[]; diagnostics: Array<Record<string, unknown>> };
  reset(): void;
  diagnostics(): Array<Record<string, unknown>>;
}

export type { MockBindingFact };

export interface MockReportAdapterPort {
  project(plan: MockPlan): Array<Record<string, unknown>>;
  hydrate(reportMocks: Array<Record<string, unknown>>): MockPlan;
}
