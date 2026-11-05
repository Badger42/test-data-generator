import type { FunctionAnalysisStatePort, FunctionAnalysisStateSnapshot } from './analysis-state.js';
import type { FunctionUnit, TypeScriptProjectSnapshot } from './ports.js';
import type { AnalysisWarning } from './domain.js';
import type { MockBehaviorOverride } from './mocks.js';

export interface AnalysisEnvironment {
  readonly sessionId: string;
  readonly project: TypeScriptProjectSnapshot;
  readonly functionUnit: FunctionUnit;
  readonly limits: Readonly<{
    maxScenarios: number;
    maxAlternatives: number;
    maxDepth: number;
  }>;
  readonly features: Readonly<{
    generateMcdc: boolean;
    constraintEngine: 'hybrid' | 'legacy';
    mockBehaviorOverrides?: Readonly<Record<string, MockBehaviorOverride>>;
    includeEvidence?: boolean;
  }>;
  /** Injected session-owned event/reducer port. */
  readonly analysisState?: FunctionAnalysisStatePort;
}

export interface FunctionAnalysisResult {
  readonly name: string;
  readonly parameters: readonly unknown[];
  readonly inferredProperties: readonly unknown[];
  readonly summary: Readonly<Record<string, number>>;
  readonly scenarios: readonly unknown[];
  readonly [key: string]: unknown;
}

export type FunctionAnalysisSessionStatus = 'created' | 'running' | 'completed' | 'failed';

/** Mutable state owned exclusively by a single FunctionAnalysisSession. */
export interface FunctionAnalysisState {
  status: FunctionAnalysisSessionStatus;
  startedAt: number | null;
  completedAt: number | null;
  eventCount: number;
  diagnostics: AnalysisWarning[];
  error: string | null;
}

export interface FunctionAnalysisSessionSnapshot {
  readonly status: FunctionAnalysisSessionStatus;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly eventCount: number;
  readonly diagnostics: readonly AnalysisWarning[];
  readonly error: string | null;
}

export interface FunctionAnalyzerAdapter {
  analyze(environment: AnalysisEnvironment): FunctionAnalysisResult;
}

export interface FunctionAnalysisSessionPort {
  readonly functionId: string;
  readonly snapshot: FunctionAnalysisSessionSnapshot;
  readonly result: FunctionAnalysisResult | null;
  readonly analysisSnapshot: FunctionAnalysisStateSnapshot;
  analyze(): FunctionAnalysisResult;
}
