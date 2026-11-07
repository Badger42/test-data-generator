import fs from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from './parse-args.mjs';
import { loadRunConfig } from './load-run-config.mjs';
import { printHelp } from './help.mjs';

/** CLI composition root. Analyzer dependencies load only for generation runs. */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const setExitCode = io.setExitCode ?? (code => { process.exitCode = code; });

  try {
    const preliminaryArgs = parseCliArgs(argv);
    if (preliminaryArgs.help) {
      printHelp(log);
      return { status: 'help' };
    }
    const cwd = path.resolve(io.cwd ?? process.cwd());
    const runConfig = loadRunConfig({
      fs,
      path,
      cwd,
      explicitPath: preliminaryArgs.runConfig,
      disabled: preliminaryArgs.noRunConfig,
    });
    const args = parseCliArgs(argv, runConfig);
    if (!args.file) {
      printHelp(log);
      throw new Error('A source file is required.');
    }

    const [{ generateScenarios }, analyzerRuntime] = await Promise.all([
      import('../application/generate-scenarios.mjs'),
      import('../runtime/typescript-analysis-runtime.mjs'),
    ]);
    return generateScenarios(args, {
      cwd,
      log,
      setExitCode,
      VERSION: analyzerRuntime.VERSION,
      analyzeFunction: analyzerRuntime.analyzeFunction,
      formatLine: analyzerRuntime.formatLine,
      runIterativeCoverageFeedback: analyzerRuntime.runIterativeCoverageFeedback,
    });
  } catch (cause) {
    error(`Error: ${cause instanceof Error ? cause.message : String(cause)}`);
    setExitCode(1);
    return { status: 'error', error: cause instanceof Error ? cause.message : String(cause) };
  }
}
