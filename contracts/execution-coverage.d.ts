/** JSON-safe contracts for execution and coverage feedback boundaries. */
import type { SerializedValue, AnalysisWarning } from './domain.js';

export interface CoverageCaseReference {
  type: 'branch' | 'mcdc';
  functionName: string;
  scenarioId?: string;
  branchId?: string;
  outcome?: boolean | string | number | null;
  decisionId?: string;
  conditionId?: string;
  pairId?: string;
  side?: 'conditionFalse' | 'conditionTrue';
  mcdcAssertion?: McdcInputAssertion;
}

export interface McdcInputAssertion {
  decisionExpression: string;
  conditions: Array<{ id: string; expression: string }>;
  expectedAtomicConditionValues: Record<string, boolean>;
  expectedDecisionOutcome: boolean;
  callbackContext?: Record<string, unknown> | null;
  functionParameterNames: Array<string | null>;
}

export interface CoverageExecutionCase {
  id: string;
  testName: string;
  arguments: SerializedValue[];
  mocks: Array<Record<string, unknown>>;
  references: CoverageCaseReference[];
}

export interface CoverageMcdcPairExecution {
  functionName: string;
  decisionId: string;
  conditionId: string;
  pairId: string;
  callbackContext?: Record<string, unknown> | null;
  conditionFalseCaseId: string;
  conditionTrueCaseId: string;
  status?: string;
}

export interface JestRunnerDescriptor {
  command: string;
  prefixArgs: string[];
  shell: boolean;
}

export interface JestProcessResult {
  status: number | null;
  signal?: string | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}

export interface JestCaseResult {
  id: string;
  status: string;
  failureMessages: string[];
  references: CoverageCaseReference[];
}

export interface JestTestResults {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  setupHookCalls?: number;
  cases: JestCaseResult[];
  error?: string;
}

export interface IstanbulBranchLocation {
  start?: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface IstanbulBranchMapEntry {
  type: string;
  loc?: IstanbulBranchLocation;
  locations?: IstanbulBranchLocation[];
}

export interface IstanbulFileCoverage {
  path?: string;
  statementMap?: Record<string, unknown>;
  fnMap?: Record<string, unknown>;
  branchMap?: Record<string, IstanbulBranchMapEntry>;
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
  l?: Record<string, number>;
  [key: string]: unknown;
}

export type IstanbulCoverageMap = Record<string, IstanbulFileCoverage>;

export interface RuntimeDecisionTrace {
  caseId: string;
  decisionId: string;
  decisionOutcome: boolean | null;
  conditions: Record<string, { value?: boolean; evaluated: boolean }>;
  callbackContext?: Record<string, unknown> | null;
  executionStatus: 'completed' | 'threw';
  error?: string;
}

export interface ScenarioCoverageAttribution {
  version: 1;
  method: 'runtime-decision-traces';
  totalCases: number;
  passedCases: number;
  casesWithBranchAttribution: number;
  cases: Array<Record<string, unknown>>;
  notes: string[];
}

export interface CoverageFeedbackUseCasePort {
  createCoverageFeedback(
    result: { functions: Array<Record<string, unknown>> },
    sourceFile: string,
    outputFile: string,
    options: Record<string, unknown>,
  ): Record<string, unknown>;
}

export interface CoverageWarning extends AnalysisWarning {
  code: string;
}
