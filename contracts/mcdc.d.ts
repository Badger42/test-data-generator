import type { AnalysisWarning, SourceSpan } from './domain.js';

export interface McdcAtomicConditionDescriptor {
  key: string;
  expression: string;
  sourceSpan: SourceSpan;
}

export interface McdcDecisionDescriptor {
  decisionId: string;
  kind: 'if' | 'ternary' | 'loop' | 'callback' | string;
  expression: string;
  sourceSpan: SourceSpan;
  conditions: McdcAtomicConditionDescriptor[];
  analysisStatus: 'complete' | 'partial' | 'unsupported';
  warnings: AnalysisWarning[];
}

export interface McdcPairCandidate {
  targetIndex: number;
  baseValues: boolean[];
  falseValues: boolean[];
  trueValues: boolean[];
  falseDecision: boolean;
  trueDecision: boolean;
  fixedConditions: Record<string, boolean>;
}

export interface McdcPairPlan {
  candidates: McdcPairCandidate[];
  combinationCount: number;
  totalCombinations: number;
  truncated: boolean;
}

export interface McdcRuntimeInstrumentation {
  enabled: boolean;
  symbol: string;
  decisionsDiscovered: number;
  decisionsInstrumented: number;
  conditionsDiscovered: number;
  conditionsInstrumented: number;
  skipped: Array<{ decisionId: string; conditionId?: string | null; kind: string; reason: string }>;
  insertionEvents: Array<{ generatedStart: number; generatedEnd: number; originalOffset: number }>;
  instrumentedSourceLength?: number;
  originalSourceLength?: number;
}

export interface McdcRuntimeRecord {
  caseId: string;
  decisionId: string;
  decisionOutcome: boolean | null;
  conditions: Record<string, { value: boolean; evaluated: boolean }>;
  callbackContext?: Record<string, unknown> | null;
  executionStatus: 'completed' | 'threw';
  error?: string;
}

export interface McdcRuntimeRecorder {
  beginCase(caseId: string): void;
  enterCallback(context: Record<string, unknown>): unknown;
  leaveCallback(previous: unknown): void;
  condition<T>(decisionId: string, conditionId: string, evaluate: () => T): T;
  conditionAsync<T>(decisionId: string, conditionId: string, evaluate: () => Promise<T>): Promise<T>;
  decision<T>(decisionId: string, evaluate: () => T): T;
  decisionAsync<T>(decisionId: string, evaluate: () => Promise<T>): Promise<T>;
  snapshot(): McdcRuntimeRecord[];
}

export interface McdcRuntimeSideVerification {
  status: string;
  trace?: McdcRuntimeRecord;
  reason?: string;
  missingConditions?: string[];
  unresolvedConditions?: string[];
  mismatchedConditions?: string[];
}

export interface McdcDecisionExtractorPort {
  nodeKey(node: unknown, sourceFile: unknown): string;
  collectAtomicConditions(node: unknown, sourceFile: unknown): unknown[];
  evaluateDecision(node: unknown, atomValues: Map<string, boolean>, sourceFile: unknown): boolean | null;
}
