/** Pure CLI argument parser. It has no dependency on the analyzer or Node APIs. */
function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseCliArgs(argv, runConfig = {}) {
  const result = {
    file: null, functionName: null, exportName: null, out: null, tsconfig: null,
    runConfig: null, noRunConfig: false,
    jestConfig: null, jestBin: null, jestSetup: null, coverageFrom: null,
    coverageProvider: 'v8', maxScenarios: 40, coverageIterations: 3,
    coverageGoal: 100, jestTimeoutMs: 120_000, coverageFeedbackTimeoutMs: 600_000, all: false, mcdc: false, coverageFeedback: false,
    minimalSuite: false, minimalSuiteOut: null, testBatching: true, testBatchMinSize: 2, testBatchMaxSize: 100,
    constraintEngine: 'hybrid', constraintDiagnostics: false, includeEvidence: false,
    analysisReport: false, analysisReportOut: null, analysisReportFormOut: null, analysisReportValueMode: 'shape', analysisReportMaxScenarios: 500,
  };

  if (runConfig == null || typeof runConfig !== 'object' || Array.isArray(runConfig)) {
    throw new Error('Run configuration must contain a JSON object.');
  }
  const configKeys = new Set(Object.keys(result).filter(key => !['runConfig', 'noRunConfig', 'help'].includes(key)));
  for (const key of Object.keys(runConfig)) {
    if (key === '$schema') continue;
    if (!configKeys.has(key)) throw new Error(`Unknown run configuration option: ${key}`);
  }
  Object.assign(result, Object.fromEntries(Object.entries(runConfig).filter(([key]) => key !== '$schema')));

  let fileArgumentSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--run-config') { result.runConfig = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--no-run-config') result.noRunConfig = true;
    else if (arg === '--function' || arg === '-f') { result.functionName = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--out' || arg === '-o') { result.out = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--tsconfig' || arg === '--jsconfig' || arg === '--config') { result.tsconfig = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--export') { result.exportName = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--jest-config') { result.jestConfig = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--jest-bin') { result.jestBin = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--jest-setup') { result.jestSetup = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--coverage-provider') { result.coverageProvider = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--coverage-from') { result.coverageFrom = requireOptionValue(argv, i, arg); result.coverageFeedback = true; i += 1; }
    else if (arg === '--coverage-feedback') result.coverageFeedback = true;
    else if (arg === '--minimal-suite') { result.minimalSuite = true; result.coverageFeedback = true; result.mcdc = true; }
    else if (arg === '--minimal-suite-out') { result.minimalSuite = true; result.minimalSuiteOut = requireOptionValue(argv, i, arg); result.coverageFeedback = true; result.mcdc = true; i += 1; }
    else if (arg === '--coverage-iterations') { result.coverageIterations = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--coverage-goal') { result.coverageGoal = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--jest-timeout') { result.jestTimeoutMs = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--coverage-feedback-timeout') { result.coverageFeedbackTimeoutMs = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--max-scenarios') { result.maxScenarios = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--constraint-engine') { result.constraintEngine = requireOptionValue(argv, i, arg); i += 1; }
    else if (arg === '--constraint-diagnostics') result.constraintDiagnostics = true;
    else if (arg === '--include-evidence') result.includeEvidence = true;
    else if (arg === '--analysis-report') result.analysisReport = true;
    else if (arg === '--analysis-report-out') { if (!next || next.startsWith('-')) throw new Error('--analysis-report-out requires a file path.'); result.analysisReport = true; result.analysisReportOut = next; i += 1; }
    else if (arg === '--analysis-report-form-out') { if (!next || next.startsWith('-')) throw new Error('--analysis-report-form-out requires a file path.'); result.analysisReport = true; result.analysisReportFormOut = next; i += 1; }
    else if (arg === '--analysis-report-values') { const value = requireOptionValue(argv, i, arg); result.analysisReportValueMode = value; i += 1; }
    else if (arg === '--analysis-report-max-scenarios') { if (!next || next.startsWith('-')) throw new Error('--analysis-report-max-scenarios requires a number.'); result.analysisReportMaxScenarios = Number(next); i += 1; }
    else if (arg === '--no-test-batching') result.testBatching = false;
    else if (arg === '--test-batch-min-size') { result.testBatchMinSize = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--test-batch-max-size') { result.testBatchMaxSize = Number(requireOptionValue(argv, i, arg)); i += 1; }
    else if (arg === '--all') result.all = true;
    else if (arg === '--mcdc') result.mcdc = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (!arg.startsWith('-') && !fileArgumentSeen) { result.file = arg; fileArgumentSeen = true; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.runConfig && result.noRunConfig) throw new Error('--run-config cannot be combined with --no-run-config.');
  for (const [name, value] of [['--jest-timeout', result.jestTimeoutMs], ['--coverage-feedback-timeout', result.coverageFeedbackTimeoutMs]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
      throw new Error(`${name} must be an integer between 1 and 86400000 milliseconds.`);
    }
  }
  return result;
}
