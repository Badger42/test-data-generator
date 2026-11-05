import type { SourceSpan } from './domain.js';

/**
 * Per-function path state exposed to AST-aware analysis adapters.
 * Extracted analyzers do not serialize these values into ScenarioCase JSON.
 */
export interface ControlFlowPathSolution {
  assignments: Map<string, unknown>;
  unsupported: string[];
}

/** Outcomes stay distinct until their owning control-flow construct consumes them. */
export interface ControlFlowResult {
  normal: ControlFlowPathSolution[];
  breaks: ControlFlowPathSolution[];
  continues: ControlFlowPathSolution[];
  returns: ControlFlowPathSolution[];
}

/**
 * TypeScript-aware per-function context. Mutable analysis results remain owned by
 * FunctionAnalysisSession; the fields here are read-only analysis inputs and
 * narrowly scoped per-function metadata.
 */
export interface AstFunctionContext {
  sourceFile: import('typescript').SourceFile;
  activeAnalysisMetadata?: Record<string, unknown> | null;
  branchCount: number;
  loopCount: number;
  parameterMap: Map<string, unknown>;
  localMockMap: Map<string, unknown>;
  checker: import('typescript').TypeChecker;
  pathAliases: Map<string, unknown>;
  localConstants: Map<string, unknown>;
  maxScenarios: number;
  branchSeen: Set<string>;
  scenarios: unknown[];
  unsupportedBranches: unknown[];
  mcdcDecisions: unknown[];
}

/** @deprecated Use AstFunctionContext. */
export type LegacyControlFlowContext = AstFunctionContext;

export interface ControlFlowAnalyzerPort {
  analyzeStatements(
    statements: readonly import('typescript').Statement[],
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
  ): ControlFlowResult;
}

export interface LoopAnalyzerPort {
  analyzeForEachLoop(
    statement: import('typescript').ForOfStatement | import('typescript').ForInStatement,
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
    isForIn: boolean,
  ): ControlFlowResult;
  analyzeClassicForLoop(
    statement: import('typescript').ForStatement,
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
  ): ControlFlowResult;
  analyzeWhileLoop(
    statement: import('typescript').WhileStatement | import('typescript').DoStatement,
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
    isDoWhile: boolean,
  ): ControlFlowResult;
}

export interface ControlFlowDiagnostics {
  sourceSpan?: SourceSpan;
  code: string;
  message: string;
}

/**
 * Function-scoped orchestration boundary. The orchestrator creates one
 * ControlFlowAnalyzer instance per analyzed function and projects its result
 * from the session-owned state snapshot. The concrete context remains an
 * adapter concern at the TypeScript front-end boundary.
 */
export interface FunctionAnalysisOrchestratorPort {
  analyzeFunction(
    fn: import('typescript').FunctionLikeDeclaration,
    sourceFile: import('typescript').SourceFile,
    checker: import('typescript').TypeChecker,
    maxScenarios: number,
    generateMcdc?: boolean,
    generationOptions?: Readonly<Record<string, unknown>>,
  ): import('./analysis-session.js').FunctionAnalysisResult;
}

/** Expression-level traversal owns AST visitation, not solver/state mutation. */
export interface ExpressionTraversalPort {
  analyzeTernaries(
    node: import('typescript').Node,
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
  ): void;
}
