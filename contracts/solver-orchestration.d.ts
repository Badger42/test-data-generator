import type { ConstraintSolverPort } from './constraints.js';
import type { FunctionAnalysisStateEvent } from './analysis-state.js';

export interface AnalysisOperationContext {
  readonly function: Readonly<{
    node: unknown;
    sourceFile: unknown;
    checker: unknown;
    typeModelProvider?: unknown;
  }>;
  readonly limits: Readonly<{
    maxScenarios: number;
    maxAlternatives: number;
    maxMcdcAtoms?: number;
    maxMcdcCombinations?: number;
    coverageExpansion?: boolean;
  }>;
  readonly constraints: Readonly<{
    engine: 'hybrid' | 'recursive-ast';
    solver: ConstraintSolverPort;
    expressionAliasResolver?: unknown;
  }>;
  readonly paths: Readonly<{
    parameterMap: Map<string, unknown>;
    localMockMap: Map<string, unknown>;
    pathAliases: Map<string, unknown>;
    inferredPaths: Map<string, unknown>;
    dataFlowModel?: unknown;
    localConstants: Map<string, unknown>;
    baseArgs?: Record<string, unknown>;
  }>;
  readonly arrays: Readonly<{
    metadata: Readonly<Record<string, unknown>>;
    callbackSeen: Set<string>;
    pipelineSeen: Set<string>;
  }>;
  readonly mcdc: Readonly<{
    enabled: boolean;
    seen: Set<string>;
  }>;
  readonly events: Readonly<{
    dispatch(event: FunctionAnalysisStateEvent): void;
    incrementConstraintStat(key: string, amount?: number): void;
    recordConstraintFallback(reason: string): void;
  }>;
}

export interface ConstraintAnalysisServicePort {
  solveCondition(node: unknown, desired: boolean, context: AnalysisOperationContext, incoming?: readonly unknown[] | null): unknown[];
  trySolveWithConstraintIR(node: unknown, desired: boolean, context: AnalysisOperationContext, incoming?: readonly unknown[] | null): unknown[] | null;
}

export interface RecursiveAstFallbackAdapterPort {
  solve(current: unknown, desired: boolean, context: AnalysisOperationContext, solveCondition: (...args: unknown[]) => unknown[]): unknown[];
}

export interface McdcAnalysisOrchestratorPort {
  analyzeMcdcDecision(condition: unknown, incoming: readonly unknown[], context: AnalysisOperationContext, kind: string, decisionNode?: unknown, runtimeExpressionNode?: unknown): void;
  solveMcdcAssignment(atoms: readonly unknown[], values: readonly boolean[], incoming: readonly unknown[], context: AnalysisOperationContext): unknown[];
}
