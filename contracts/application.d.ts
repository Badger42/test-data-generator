export interface GenerateScenariosOptions {
  file: string;
  functionName: string | null;
  exportName: string | null;
  out: string | null;
  tsconfig: string | null;
  jestConfig: string | null;
  jestBin: string | null;
  jestSetup: string | null;
  coverageFrom: string | null;
  coverageProvider: 'v8' | 'babel';
  maxScenarios: number;
  coverageIterations: number;
  coverageGoal: number;
  all: boolean;
  mcdc: boolean;
  coverageFeedback: boolean;
  minimalSuite: boolean;
  minimalSuiteOut: string | null;
  includeEvidence?: boolean;
  constraintEngine?: 'hybrid' | 'legacy';
  constraintDiagnostics?: boolean;
  analysisReport?: boolean;
  analysisReportOut?: string | null;
  analysisReportFormOut?: string | null;
  analysisReportValueMode?: 'shape' | 'hash' | 'include';
  analysisReportMaxScenarios?: number;
}

export type GenerateScenariosResult =
  | { status: 'generated'; result: unknown; outputFile: string; analysisReportFile?: string | null; analysisRunFormFile?: string | null }
  | { status: 'selection-required'; functions: string[] }
  | { status: 'error'; error: string };

export interface ApplicationRuntime {
  cwd?: string;
  log?: (message: string) => void;
  setExitCode?: (code: number) => void;
}

export interface GenerateScenariosUseCase {
  execute(options: GenerateScenariosOptions, runtime?: ApplicationRuntime): GenerateScenariosResult;
}
