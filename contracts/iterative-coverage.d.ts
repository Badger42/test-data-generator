/** Contracts for bounded targeted coverage-feedback expansion. */
import type { MinimalTestSetReport } from './minimization.js';

export interface CoverageIterationSummary {
  iteration: number;
  status: string;
  generatedScenarioCount: number;
  addedScenarioCount: number;
  executedScenarioCount: number | null;
  jestTests?: { total?: number; passed?: number; failed?: number } | null;
  branchCoverage?: { covered?: number; total?: number; pct?: number | null } | null;
  staticTargets?: Record<string, number> | null;
}

export interface IterativeCoverageFeedbackReport {
  enabled: boolean;
  strategy?: 'targeted-static-branch-expansion';
  maxIterations: number;
  coverageGoalPct?: number;
  initialMaxScenarios?: number;
  finalMaxScenarios?: number;
  totalAdditionalScenarios?: number;
  iterations: CoverageIterationSummary[];
  stopReason: string;
  goalReached?: boolean;
  note?: string;
}

export interface IterativeCoverageFeedbackArgs {
  maxScenarios: number;
  coverageIterations: number;
  coverageGoal: number;
  coverageFrom?: string | null;
  minimalSuite?: boolean;
  mcdc?: boolean;
  constraintEngine?: 'hybrid' | 'legacy';
  mockBehaviorOverrides?: Record<string, unknown>;
}

export interface IterativeCoverageFeedbackUseCase {
  execute(
    result: { functions: Array<Record<string, unknown>> },
    selectedFunctionNodes: unknown[],
    sourceFile: string,
    outputFile: string,
    args: IterativeCoverageFeedbackArgs,
    checker: unknown,
    sourceFileNode: unknown,
  ): Record<string, unknown> & {
    minimalTestSet?: MinimalTestSetReport;
    iterative: IterativeCoverageFeedbackReport;
  };
}
