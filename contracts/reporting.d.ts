import type { AnalysisWarning, JsonValue } from './domain.js';

export interface GenerationReportFunction {
  name: string;
  scenarios: Array<Record<string, unknown>>;
  summary: Record<string, number | string | boolean | null>;
  [key: string]: unknown;
}

export interface GenerationReport {
  generator: { name: string; version: string };
  source: string;
  sourceLanguage: 'javascript' | 'typescript';
  generatedAt: string;
  limitations: string[];
  functions: GenerationReportFunction[];
  constraintEngine?: Record<string, JsonValue>;
  coverageFeedback?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReportBuilderInput {
  version: string;
  source: string;
  sourceLanguage: 'javascript' | 'typescript';
  generatedAt?: string;
  limitations: string[];
  functions: GenerationReportFunction[];
  functionResults?: Array<{ _constraintStats?: Record<string, unknown> }>;
  constraintDiagnostics?: boolean;
  constraintEngine?: 'hybrid' | 'legacy';
}

export interface ReportBuilder {
  build(input: ReportBuilderInput): GenerationReport;
}

export interface ReportValidationResult {
  valid: boolean;
  errors: string[];
}

export declare function validateGenerationReport(report: unknown): ReportValidationResult;
export declare function assertGenerationReport<T>(report: T): T;
export declare function createReportBuilder(): ReportBuilder;


export interface ScenarioReportAdapterPort {
  project(scenario: import('./domain.js').ScenarioCase, input: {
    target: Record<string, unknown>;
    mocks?: Array<Record<string, unknown>>;
    unsupported?: string[];
    includeEvidence?: boolean;
  }): Record<string, unknown>;
}

export interface MockReportAdapterPort {
  project(plan: import('./mocks.js').MockPlan): Array<Record<string, unknown>>;
  hydrate(reportMocks: Array<Record<string, unknown>>): import('./mocks.js').MockPlan;
}
