/** Parser-independent Constraint IR and solver contracts. */
export type ConstraintOperator = 'truthy' | '==' | '===' | '!=' | '!==' | '<' | '<=' | '>' | '>=' | 'unsupported';
export type ConstraintAccessor = 'value' | 'length';
export type ConstraintValueType = 'unknown' | 'string' | 'number' | 'boolean' | 'null' | 'undefined';
export type ConstraintPathType = 'unknown' | 'string' | 'number' | 'boolean' | 'array' | 'object';
export interface ConstraintPathTypeHint { kind: ConstraintPathType; optional?: boolean; nullable?: boolean; allowedValues?: Array<string | number | boolean> }
export type ConstraintUndefined = { $constraintValue: 'undefined' };
export type ConstraintLiteral = string | number | boolean | null | ConstraintUndefined;

export interface ConstraintSourceSpan {
  file?: string;
  start?: number;
  end?: number;
}

export type ConstraintValueExpr =
  | { kind: 'literal'; value: ConstraintLiteral }
  | { kind: 'path'; path: string[]; accessor?: ConstraintAccessor; pathTypeHint?: ConstraintPathTypeHint }
  | { kind: 'unary'; operator: '+' | '-'; operand: ConstraintValueExpr }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '%' | '**'; left: ConstraintValueExpr; right: ConstraintValueExpr };

export interface ConstraintAtom {
  kind: 'atom';
  id: string;
  /** Compatibility direct left-operand path. Empty when expression operands are used. */
  path: string[];
  accessor?: ConstraintAccessor;
  operator: ConstraintOperator;
  /** Present for path-vs-literal comparisons; may explicitly contain null. */
  value?: ConstraintLiteral;
  /** Present instead of value for path-vs-path comparisons. */
  valuePath?: string[];
  valueAccessor?: ConstraintAccessor;
  valuePathTypeHint?: ConstraintPathTypeHint;
  /** Arithmetic/value IR operands. AST nodes must never be stored here. */
  leftExpression?: ConstraintValueExpr;
  rightExpression?: ConstraintValueExpr;
  source: ConstraintSourceSpan | null;
  valueType: ConstraintValueType;
  pathType?: ConstraintPathType;
  pathTypeHint?: ConstraintPathTypeHint;
  unsupportedReason?: string;
}

export interface ConstraintLogical {
  kind: 'logical';
  operator: 'and' | 'or';
  operands: ConstraintExpr[];
}
export interface ConstraintNot { kind: 'not'; operand: ConstraintExpr }
export interface ConstraintConstant { kind: 'constant'; value: boolean }
export type ConstraintExpr = ConstraintAtom | ConstraintLogical | ConstraintNot | ConstraintConstant;

export interface ConstraintDiagnostic {
  code: string;
  atomId: string;
  message?: string;
}
export interface ConstraintIR {
  irVersion: 1 | 2;
  expression: ConstraintExpr;
  /** Atom metadata in deterministic expression traversal order. */
  atoms: ConstraintAtom[];
  diagnostics: ConstraintDiagnostic[];
}

export interface SolveOptions {
  desired?: boolean;
  maxCandidates?: number;
  /** Existing data is a seed, not a fixed constraint; the solver may refine it. */
  seed?: Record<string, unknown>;
  /** Type hints keyed by JSON path (e.g. `["input","items"]`) or dotted path. */
  pathTypes?: Record<string, ConstraintPathType | ConstraintPathTypeHint>;
}
export interface SolveAllOptions extends SolveOptions {
  /** Maximum number of distinct assignments returned (default: 40). */
  maxSolutions?: number;
  /** Maximum number of disjoint short-circuit clauses (default: 512). */
  maxBranches?: number;
  /** Maximum number of representative assignments returned per disjoint clause (default: maxSolutions). Set to 1 to return one witness for every short-circuit path. */
  solutionsPerClause?: number;
}
export interface NumericDomainIntersection {
  path: string[];
  kind: 'numeric-interval' | 'integer-length';
  lower?: { value: number; inclusive: boolean };
  upper?: { value: number; inclusive: boolean };
  excluded?: number[];
  equalTo?: number;
  impossible?: boolean;
}
export type SolveResult =
  | { status: 'solved'; assignments: Record<string, unknown>; attempts: number }
  | { status: 'unsatisfiable'; reason: string; assignments: []; attempts: number }
  | { status: 'limit-reached'; reason: string; assignments: []; attempts: number }
  | { status: 'unsupported'; reason: string; assignments: []; attempts?: number; unsupported?: string[] };
export type SolveAllResult =
  | { status: 'solved'; assignments: Record<string, unknown>; solutions: Record<string, unknown>[]; solutionPaths: string[][][]; solutionDomains: NumericDomainIntersection[][]; attempts: number; complete: boolean; truncated?: boolean; unsupported: string[]; domainIntersections: NumericDomainIntersection[] }
  | { status: 'unsatisfiable'; reason: string; assignments: []; solutions: []; solutionPaths: []; solutionDomains: []; attempts: number; complete: true; unsupported: string[]; domainIntersections: NumericDomainIntersection[] }
  | { status: 'limit-reached'; reason: string; assignments: []; solutions: []; solutionPaths: []; solutionDomains: []; attempts: number; complete: false; unsupported: string[]; domainIntersections?: NumericDomainIntersection[] }
  | { status: 'unsupported'; reason: string; assignments: []; solutions: []; solutionPaths: []; solutionDomains: []; attempts: number; complete: false; unsupported: string[] };

export interface ConstraintSolverPort {
  solve(ir: ConstraintIR | ConstraintExpr, options?: SolveOptions): SolveResult;
  solveAll(ir: ConstraintIR | ConstraintExpr, options?: SolveAllOptions): SolveAllResult;
}
