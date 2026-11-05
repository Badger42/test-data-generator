/** Shareable, privacy-aware diagnostic export produced after a generation run. */
export type AnalysisReportValueMode = 'shape' | 'hash' | 'include';

export interface AnalysisReport {
  reportType: 'branch-scenarios-analysis-report';
  schemaVersion: string;
  reportId: string;
  generatedAt: string;
  generator: { name: string; version: string };
  environment: { node: string; platform: string; architecture: string; typescript: string | null };
  project: {
    root: string;
    fingerprint: string;
    fileDigests: Array<{ file: string; sha256: string; bytes: number; lineCount: number }>;
    sourceFileCount: number;
    files: string[];
    imports: { total: number; resolved: number; unresolved: number; edges: Array<Record<string, unknown>> };
    functionIndex: Record<string, unknown>;
    source: { file: string; language: 'javascript' | 'typescript'; sha256: string; bytes: number; lineCount: number };
  };
  run: { valueMode: AnalysisReportValueMode; [key: string]: unknown };
  summary: Record<string, unknown>;
  functions: Array<Record<string, unknown>>;
  callGraph: Record<string, unknown>;
  execution: Record<string, unknown>;
  externalExecution: Record<string, unknown> & { executionForm?: { formType: string; schemaVersion: string; status: string; file: string | null } };
  diagnostics: Record<string, unknown>;
  privacy: { valueMode: AnalysisReportValueMode; valuesIncluded: boolean; sourceCodeIncluded: boolean; sourceExpressionsIncluded: boolean; absolutePathsIncluded: boolean; note: string };
  assistantHandoff: Record<string, unknown>;
}

export interface AnalysisReportBuilder {
  build(input: {
    project: unknown;
    report: unknown;
    functionResults?: unknown[];
    functionUnits?: unknown[];
    sessions?: unknown[];
    args?: Record<string, unknown>;
    valueMode?: AnalysisReportValueMode;
    maxScenarios?: number;
  }): AnalysisReport;
}

export declare const ANALYSIS_REPORT_SCHEMA_VERSION: string;
export declare function createAnalysisReportBuilder(): AnalysisReportBuilder;
export declare function validateAnalysisReport(report: unknown): { valid: boolean; errors: string[] };
export declare function assertAnalysisReport<T>(report: T): T;

export interface AnalysisRunForm {
  formType: 'branch-scenarios-execution-results-form';
  schemaVersion: string;
  reportId: string;
  execution: Record<string, unknown>;
  testResults: { total: number | null; passed: number | null; failed: number | null; skipped: number | null; plannedCases: number; truncatedCases: number; cases: Array<Record<string, unknown>>; additionalTestsNotLinkedToScenarios: unknown[] };
  coverage: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  notes: string[];
  issues: unknown[];
}
export declare function createAnalysisRunForm(input: { analysisReport: AnalysisReport; functionResults?: unknown[]; coverageFeedback?: unknown }): AnalysisRunForm;
export declare function validateAnalysisRunForm(form: unknown): { valid: boolean; errors: string[] };
export declare function assertAnalysisRunForm<T>(form: T): T;
export declare function finalizeAnalysisReport(report: AnalysisReport, form: AnalysisRunForm): AnalysisReport;
