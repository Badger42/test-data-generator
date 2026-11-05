import { parseCliArgs } from './parse-args.mjs';
import { printHelp } from './help.mjs';

/** CLI composition root. Analyzer dependencies load only for generation runs. */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const setExitCode = io.setExitCode ?? (code => { process.exitCode = code; });

  try {
    const args = parseCliArgs(argv);
    if (args.help) {
      printHelp(log);
      return { status: 'help' };
    }
    if (!args.file) {
      printHelp(log);
      throw new Error('A source file is required.');
    }

    const [{ generateScenarios }, analyzerRuntime] = await Promise.all([
      import('../application/generate-scenarios.mjs'),
      import('../runtime/typescript-analysis-runtime.mjs'),
    ]);
    return generateScenarios(args, {
      cwd: io.cwd ?? process.cwd(),
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
