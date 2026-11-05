import type { GenerateScenariosOptions } from './application.js';

export type ParsedCliOptions = Omit<GenerateScenariosOptions, 'file'> & { file: string | null; help?: boolean };

export interface CliParser {
  parse(argv: string[]): ParsedCliOptions;
}

export interface CliRuntime {
  log?: (message: string) => void;
  error?: (message: string) => void;
  cwd?: string;
  setExitCode?: (code: number) => void;
}

export interface CliRunner {
  run(argv?: string[], runtime?: CliRuntime): Promise<
    | { status: 'help' }
    | { status: 'generated'; result: unknown; outputFile: string; analysisReportFile?: string | null; analysisRunFormFile?: string | null }
    | { status: 'selection-required'; functions: string[] }
    | { status: 'error'; error: string }
  >;
}
