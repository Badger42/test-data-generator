/** Static contract for grouping independent ScenarioCases into Jest test.each tables. */
export interface TestBatchExecutionSignature {
  version: 1;
  target: string;
  exportPath: string;
  setupProfile: string;
  environment: string;
  lifecycle: string;
  runtime: string;
  /** Stable call-site identifiers; values and behaviors are intentionally row-specific. */
  mockMethods: string[];
}

export interface TestBatchableCase {
  id: string;
  testName?: string;
  functionId?: string;
  functionName?: string;
  exportPath?: string;
  setupProfileId?: string;
  environmentSignature?: string;
  lifecycle?: string;
  runtimeKind?: string;
  mocks?: Array<{
    call?: string;
    callId?: string;
    callSiteId?: string;
    callExpression?: string;
    behavior?: string;
    [key: string]: unknown;
  }>;
  requiresDedicatedTest?: boolean;
  requiresIsolation?: boolean;
  unsupported?: unknown[];
  batching?: { allowed?: boolean; reason?: string };
  [key: string]: unknown;
}

export interface TestBatch<TCase extends TestBatchableCase = TestBatchableCase> {
  id: string;
  signature: TestBatchExecutionSignature;
  cases: readonly TCase[];
  scenarioIds: readonly string[];
}

export interface TestBatchDiagnostic {
  caseId: string;
  code: 'TEST_CASE_NOT_BATCHABLE';
  reasons: readonly string[];
}

export interface TestBatchPlanStats {
  inputCases: number;
  batchedCases: number;
  individualCases: number;
  batchCount: number;
  averageBatchSize: number;
}

export interface TestBatchPlanEntry {
  kind: 'batch' | 'individual';
  batchId?: string;
  scenarioId?: string;
  /** Original scenario order, used to preserve Jest registration order. */
  firstIndex: number;
}

export interface TestBatchPlan<TCase extends TestBatchableCase = TestBatchableCase> {
  version: 1;
  batches: readonly TestBatch<TCase>[];
  individual: readonly (TCase & { batchReason?: string })[];
  entries: readonly TestBatchPlanEntry[];
  diagnostics: readonly TestBatchDiagnostic[];
  stats: TestBatchPlanStats;
}

export interface TestBatchBuildContext {
  functionId?: string;
  functionName?: string;
  exportPath?: string;
  setupProfileId?: string;
  environmentSignature?: string;
  lifecycle?: string;
  runtimeKind?: string;
}

export interface TestBatchBuildOptions {
  minBatchSize?: number;
  maxBatchSize?: number;
}

export interface TestBatchBuilder {
  build<TCase extends TestBatchableCase>(
    cases: readonly TCase[],
    context?: TestBatchBuildContext,
    overrides?: TestBatchBuildOptions,
  ): TestBatchPlan<TCase>;
}

export declare function createTestBatchBuilder(options?: TestBatchBuildOptions): TestBatchBuilder;
export declare function createExecutionSignature(
  testCase: TestBatchableCase,
  context?: TestBatchBuildContext,
): {
  key: string;
  signature: TestBatchExecutionSignature;
  batchable: boolean;
  reasons: readonly string[];
};
export declare function renderJestEachRegistrations(
  plan: TestBatchPlan,
  options?: { callbackName?: string; testApi?: string; batchVariable?: string; individualVariable?: string },
): string;
