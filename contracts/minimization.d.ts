/** Contracts for the candidate-suite minimization boundary. */
export type CoverageOutcome = boolean | string | number | null;

export interface CoverageObligation {
  id: string;
  type: 'branch-outcome' | 'mcdc-pair-side' | 'conservative-static-target';
  branchId?: string;
  outcome?: CoverageOutcome;
  pairId?: string;
  decisionId?: string;
  conditionId?: string;
  side?: 'conditionFalse' | 'conditionTrue';
  evidence: 'runtime-decision-trace' | 'runtime-mcdc-verification' | 'switch-target-reference' | 'aggregate-or-unmapped-target-reference';
  mappingStatus?: string;
  caseIds: string[];
}

export interface MinimizationCandidateCase {
  caseId: string;
  status: string;
  testName: string;
  arguments: unknown[];
  mocks: Array<Record<string, unknown>>;
  references: Array<Record<string, unknown>>;
  coveredBranchOutcomes: Array<{ branchId: string; outcome: CoverageOutcome }>;
  mcdcPairSides: Array<{ pairId: string; side: string; verified: boolean }>;
}

export interface CoverageObligationModel {
  cases: MinimizationCandidateCase[];
  obligationList: CoverageObligation[];
  allObligationIds: ReadonlySet<string>;
  caseCoverage: ReadonlyMap<string, ReadonlySet<string>>;
  fallbackObligationIds: ReadonlySet<string>;
}

export interface TestSuiteMinimizerOptions {
  maxExactCandidates?: number;
  maxExactObligations?: number;
  maxSearchNodes?: number;
}

export interface MinimalTestSetReport {
  status: 'unavailable' | 'partial' | 'complete' | 'complete-with-conservative-fallbacks';
  reason?: string;
  objective?: string;
  algorithm?: string;
  exactMinimumProven?: boolean;
  searchNodes?: number;
  candidateCases?: number;
  selectedCases?: number;
  removedCases?: number;
  reductionPct?: number;
  obligations?: number;
  coveredObligations?: number;
  missingObligations?: string[];
  uncoveredBranchOutcomes?: string[];
  conservativeFallbackCaseIds?: string[];
  conservativeFallbacks?: Array<Record<string, unknown>>;
  branchObligations?: number;
  mcdcPairsEligible?: number;
  mcdcPairsPreserved?: number;
  selectedCaseIds?: string[];
  removedCaseIds?: string[];
  scenarios?: Array<Record<string, unknown>>;
  notes?: string[];
}

export interface TestSuiteMinimizer {
  minimize(
    attribution: unknown,
    staticTargets: unknown[],
    pairExecution: unknown[],
  ): MinimalTestSetReport;
}
