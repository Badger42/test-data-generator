/**
 * Coverage-feedback use case. It coordinates temporary Jest execution, runtime
 * instrumentation, Istanbul remapping, MC/DC verification and result assembly.
 * Infrastructure and domain operations are injected so the use case can be tested
 * without spawning Jest or depending on TypeScript directly.
 */
import { createTestBatchBuilder } from '../testing/batching/test-batch-builder.mjs';

export function createCoverageFeedbackUseCase(deps) {
  const {
    fs, path, process, runJest, collectCoverageExecutionCases, findJestRunner,
    resolveJestWorkingDirectory, instrumentMcdcSource, buildJestFeedbackTest,
    runtimeRecorderSource, readJestTestResults, readIstanbulCoverage,
    remapCoverageMapForInstrumentedSource, buildCoverageFeedback,
    readRuntimeTraceFile, verifyRuntimeMcdcSide, buildScenarioCoverageAttribution,
  } = deps;
function createCoverageFeedback(result, sourceFile, outputFile, args) {
  const absoluteSource = path.resolve(sourceFile);
  if (args.coverageFrom) {
    const coveragePath = path.resolve(args.coverageFrom);
    if (!fs.existsSync(coveragePath)) {
      return { version: 1, status: 'coverage-input-not-found', error: `Coverage file does not exist: ${coveragePath}` };
    }
    try {
      const coverageMap = readIstanbulCoverage(coveragePath, fs);
      const feedback = buildCoverageFeedback(coverageMap, absoluteSource, result.functions, {
        runner: 'external-coverage', status: 'coverage-loaded', provider: 'from-file',
      });
      feedback.coverageInput = coveragePath;
      return feedback;
    } catch (error) {
      return { version: 1, status: 'invalid-coverage-file', error: error.message, coverageInput: coveragePath };
    }
  }

  const { cases, pairRecords } = collectCoverageExecutionCases(result.functions);
  if (!cases.length) {
    return { version: 1, status: 'no-runnable-scenarios', error: 'No supported generated scenarios were available to execute.' };
  }

  let runner;
  try {
    runner = findJestRunner(args.jestBin, absoluteSource, args.jestConfig);
  } catch (error) {
    return { version: 1, status: 'jest-not-found', error: error.message };
  }

  const sourceDirectory = path.dirname(absoluteSource);
  const jestWorkingDirectory = resolveJestWorkingDirectory(absoluteSource, args.jestConfig);
  if (runner.version) {
    const parsed = runner.version.match(/^(\d+)\.(\d+)\.(\d+)/);
    const versionTuple = parsed ? parsed.slice(1).map(Number) : null;
    const isSupported = Boolean(versionTuple && versionTuple[0] === 30 &&
      (versionTuple[1] > 5 || (versionTuple[1] === 5 && versionTuple[2] >= 2)));
    if (!isSupported) {
      return {
        version: 1, status: 'jest-version-unsupported',
        error: `Coverage feedback requires Jest >=30.5.2 <31.0.0; found ${runner.version}. Update the consuming project's Jest or pass --jest-bin to a supported installation.`,
        requiredJestVersion: '>=30.5.2 <31.0.0', actualJestVersion: runner.version,
      };
    }
  }
  let tempDirectory;
  try {
    tempDirectory = fs.mkdtempSync(path.join(sourceDirectory, '.branch-scenarios-feedback-'));
  } catch (error) {
    return {
      version: 1, status: 'temporary-directory-error',
      error: `Cannot create temporary Jest files beside the source file: ${error.message}`,
      hint: 'Ensure the source directory is writable or run the CLI from a writable copy of the project.',
    };
  }

  const testFile = path.join(tempDirectory, 'branch-scenarios-feedback.test.cjs');
  const coverageDirectory = path.join(tempDirectory, 'coverage');
  const jestResultsFile = path.join(tempDirectory, 'jest-results.json');
  const coverageFinalFile = path.join(coverageDirectory, 'coverage-final.json');
  const mcdcResultsFile = path.join(tempDirectory, 'mcdc-input-checks.json');
  const mcdcRuntimeResultsFile = path.join(tempDirectory, 'mcdc-runtime-checks.json');
  const coverageOutputFile = outputFile.replace(/\.json$/i, '') + '.coverage-final.json';
  const exportNames = new Set(result.functions.map(fn => fn.name));
  if (result.functions.length > 1) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    return {
      version: 1, status: 'ambiguous-export',
      error: 'Coverage feedback currently executes one analyzed function at a time. Specify --function <name>; --export selects its module export path.',
    };
  }
  if (args.exportName && result.functions.length === 1 && !exportNames.has(result.functions[0].name)) {
    // An explicit module export may differ from the local source declaration name.
    // This is valid (for example a default export), so keep it as a runtime resolution override.
  }

  const setupFile = args.jestSetup ? path.resolve(args.jestSetup) : null;
  if (setupFile && !fs.existsSync(setupFile)) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    return { version: 1, status: 'jest-setup-not-found', error: `Jest setup file does not exist: ${setupFile}` };
  }
  const testBatchPlan = args.testBatching === false
    ? { batches: [], individual: cases, stats: { inputCases: cases.length, batchedCases: 0, individualCases: cases.length, batchCount: 0, averageBatchSize: 0 }, diagnostics: [] }
    : createTestBatchBuilder({ minBatchSize: args.testBatchMinSize ?? 2, maxBatchSize: args.testBatchMaxSize ?? 100 }).build(cases, {
      functionName: result.functions[0]?.name ?? '',
      exportPath: args.exportName ?? '',
      setupProfileId: setupFile ?? '',
      runtimeKind: 'jest-coverage-feedback',
    });

  let runtimeSourceFile = absoluteSource;
  let runtimeInstrumentation = { enabled: false, reason: args.mcdc ? 'No instrumentable MC/DC decisions were found.' : 'MC/DC mode was not enabled.' };
  let instrumentedSourcePath = null;
  let originalSourceText = null;
  if (args.mcdc) {
    try {
      originalSourceText = fs.readFileSync(absoluteSource, 'utf8');
      const instrumented = instrumentMcdcSource(absoluteSource, originalSourceText, result.functions);
      runtimeInstrumentation = instrumented.instrumentation;
      if (runtimeInstrumentation.enabled) {
        const extension = path.extname(absoluteSource) || '.js';
        const baseName = path.basename(absoluteSource, extension);
        instrumentedSourcePath = path.join(sourceDirectory, `${baseName}.branch-scenarios-runtime-${process.pid}-${Date.now()}${extension}`);
        fs.writeFileSync(instrumentedSourcePath, instrumented.source, 'utf8');
        runtimeSourceFile = instrumentedSourcePath;
      }
    } catch (error) {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
      return { version: 1, status: 'runtime-instrumentation-error', error: error.message };
    }
  }
  fs.writeFileSync(testFile, buildJestFeedbackTest(runtimeSourceFile, args.exportName, setupFile, mcdcResultsFile, mcdcRuntimeResultsFile, result.functions, cases, runtimeRecorderSource, { enabled: args.testBatching !== false, minBatchSize: args.testBatchMinSize ?? 2, maxBatchSize: args.testBatchMaxSize ?? 100, plan: testBatchPlan }), 'utf8');
  const jestArgs = [
    ...runner.prefixArgs,
    '--runInBand',
    '--no-color',
    '--coverage',
    `--coverageProvider=${args.coverageProvider}`,
    `--coverageDirectory=${coverageDirectory}`,
    '--coverageReporters=json',
    '--runTestsByPath', testFile,
    '--json', `--outputFile=${jestResultsFile}`,
  ];
  if (instrumentedSourcePath) {
    // User configs often restrict collectCoverageFrom to the original source
    // filename. Runtime MC/DC imports a temporary sibling copy instead, so
    // explicitly include that one file for this focused coverage-feedback run.
    // A basename glob is relative to Jest's rootDir and avoids assumptions
    // about where rootDir sits relative to cwd.
    jestArgs.push('--collectCoverageFrom', `**/${path.basename(instrumentedSourcePath)}`);
  }
  if (args.jestConfig) jestArgs.push('--config', path.resolve(args.jestConfig));

  const nodeOptions = (process.env.NODE_OPTIONS ?? '').trim();
  const env = {
    ...process.env,
    NODE_OPTIONS: `${nodeOptions} --experimental-vm-modules`.trim(),
    JEST_WORKER_ID: '1',
  };
  let run;
  try {
    run = runJest(runner.command, jestArgs, {
      cwd: jestWorkingDirectory, env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      shell: Boolean(runner.shell),
    });
  } catch (error) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    if (instrumentedSourcePath) fs.rmSync(instrumentedSourcePath, { force: true });
    return { version: 1, status: 'jest-launch-error', error: error.message };
  }

  const testResults = readJestTestResults(jestResultsFile, cases, fs);
  const allCaseTestsPassed = Boolean(testResults && testResults.cases.length === cases.length && testResults.cases.every(item => item.status === 'passed'));
  const effectiveJestStatus = run.error ? 'jest-launch-error' : run.status !== 0 ? 'jest-tests-failed' : allCaseTestsPassed ? 'passed' : 'incomplete-test-results';
  let coverageMap = null;
  let coverageError = null;
  let coverageRemapping = { remapped: false, coveragePath: null };
  if (fs.existsSync(coverageFinalFile)) {
    try {
      coverageMap = readIstanbulCoverage(coverageFinalFile, fs);
      if (instrumentedSourcePath && runtimeInstrumentation?.insertionEvents) {
        coverageRemapping = remapCoverageMapForInstrumentedSource(
          coverageMap, instrumentedSourcePath, absoluteSource, originalSourceText, runtimeInstrumentation,
        );
        coverageMap = coverageRemapping.coverageMap;
      }
      fs.mkdirSync(path.dirname(coverageOutputFile), { recursive: true });
      fs.writeFileSync(coverageOutputFile, JSON.stringify(coverageMap, null, 2), 'utf8');
    } catch (error) { coverageError = error.message; }
  } else {
    coverageError = 'Jest did not produce coverage-final.json. Check coverage configuration and whether the target module was instrumented.';
  }

  const passedCaseIds = new Set((testResults?.cases ?? []).filter(item => item.status === 'passed').map(item => item.id));
  const mcdcInputResults = readRuntimeTraceFile(mcdcResultsFile, { fs, fallback: [] });
  const findPairSide = (items, pairId, side) => items.find(item => item.pairId === pairId && item.side === side);
  const mcdcRuntimeResults = readRuntimeTraceFile(mcdcRuntimeResultsFile, { fs, fallback: [] });
  const pairExecution = pairRecords.map(pair => {
    const falsePassed = passedCaseIds.has(pair.conditionFalseCaseId);
    const truePassed = passedCaseIds.has(pair.conditionTrueCaseId);
    const falseCheck = findPairSide(mcdcInputResults, pair.pairId, 'conditionFalse');
    const trueCheck = findPairSide(mcdcInputResults, pair.pairId, 'conditionTrue');
    const falseRuntime = verifyRuntimeMcdcSide(mcdcRuntimeResults, cases, pair.conditionFalseCaseId, pair, 'conditionFalse', falseCheck);
    const trueRuntime = verifyRuntimeMcdcSide(mcdcRuntimeResults, cases, pair.conditionTrueCaseId, pair, 'conditionTrue', trueCheck);
    const acceptedRuntimeStatuses = ['runtime-instrumented-verified', 'runtime-verified-with-short-circuit-inference'];
    const runtimeVerified = acceptedRuntimeStatuses.includes(falseRuntime.status) && acceptedRuntimeStatuses.includes(trueRuntime.status);
    const inputVerified = falseCheck?.status === 'verified' && trueCheck?.status === 'verified';
    const bothScenariosPassed = falsePassed && truePassed;
    let status = 'scenarios-not-passed';
    if (bothScenariosPassed && inputVerified && runtimeVerified) {
      status = [falseRuntime, trueRuntime].some(item => item.status === 'runtime-verified-with-short-circuit-inference')
        ? 'runtime-mcdc-verified-with-short-circuit-inference'
        : 'runtime-mcdc-verified';
    } else if (bothScenariosPassed && !inputVerified) {
      status = falseCheck?.status === 'not-evaluable' || trueCheck?.status === 'not-evaluable'
        ? 'input-pair-not-evaluable'
        : 'input-pair-not-verified';
    } else if (bothScenariosPassed) status = 'runtime-mcdc-not-verified';
    else if (falsePassed || truePassed) status = 'one-scenario-passed';
    return {
      ...pair, status, bothScenariosPassed,
      inputChecks: { conditionFalse: falseCheck ?? null, conditionTrue: trueCheck ?? null },
      runtimeChecks: { conditionFalse: falseRuntime, conditionTrue: trueRuntime },
    };
  });
  const allPairCasesPassed = pairExecution.length > 0 && pairExecution.every(pair =>
    ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status));

  let feedback;
  if (coverageMap) {
    feedback = buildCoverageFeedback(coverageMap, absoluteSource, result.functions, {
      runner: runner.command,
      provider: args.coverageProvider,
      status: effectiveJestStatus,
      executedScenarioCount: testResults?.numPassedTests ?? passedCaseIds.size,
      testResults: testResults ? {
        total: testResults.numTotalTests,
        passed: testResults.numPassedTests,
        failed: testResults.numFailedTests,
        pending: testResults.numPendingTests,
      } : null,
      inputPairVerification: pairExecution.length === 0 ? 'no-mcdc-pairs-generated' : allPairCasesPassed
        ? pairExecution.every(pair => pair.status === 'runtime-mcdc-verified')
          ? 'all-pairs-runtime-instrumented'
          : 'all-pairs-runtime-verified-with-short-circuit-inference'
        : 'not-all-pairs-runtime-verified',
    });
  } else {
    feedback = {
      version: 1,
      status: effectiveJestStatus === 'passed' ? 'coverage-not-produced' : effectiveJestStatus,
      runner: runner.command,
      executedScenarioCount: testResults?.numPassedTests ?? passedCaseIds.size,
      testResults,
    };
  }
  if (feedback.mcdc) {
    const runtimeVerified = pairExecution.filter(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status));
    feedback.mcdc.runtimeInstrumentation = {
      enabled: Boolean(instrumentedSourcePath && runtimeInstrumentation?.enabled),
      instrumentedSource: instrumentedSourcePath ? path.basename(instrumentedSourcePath) : null,
      instrumentedSourceCleanup: instrumentedSourcePath ? 'removed-after-run' : 'not-created',
      decisionsDiscovered: runtimeInstrumentation?.decisionsDiscovered ?? 0,
      decisionsInstrumented: runtimeInstrumentation?.decisionsInstrumented ?? 0,
      conditionsDiscovered: runtimeInstrumentation?.conditionsDiscovered ?? 0,
      conditionsInstrumented: runtimeInstrumentation?.conditionsInstrumented ?? 0,
      skipped: runtimeInstrumentation?.skipped ?? [],
      recordedDecisionExecutions: mcdcRuntimeResults.length,
      verifiedIndependencePairs: runtimeVerified.length,
      shortCircuitInferencePairs: pairExecution.filter(pair => pair.status === 'runtime-mcdc-verified-with-short-circuit-inference').length,
      coveragePathRemapped: Boolean(coverageRemapping.remapped),
      coveragePathRemappedFrom: coverageRemapping.coveragePath,
      semantics: 'The target source is instrumented at each analyzed decision and atomic-condition expression. Instrumentation records actual evaluated atom values and the actual decision outcome during target-function execution. Short-circuited fixed conditions are reported separately as inferred from the concrete-input check; the target condition whose independent effect is being measured must be observed at runtime on both sides. A pair is fully runtime-instrumented only when every atom is observed on both sides.',
    };
    feedback.mcdc.verificationScope = {
      generatedPairs: pairExecution.length,
      runtimeVerifiedPairs: runtimeVerified.length,
      fullyInstrumentedPairs: pairExecution.filter(pair => pair.status === 'runtime-mcdc-verified').length,
      shortCircuitInferencePairs: pairExecution.filter(pair => pair.status === 'runtime-mcdc-verified-with-short-circuit-inference').length,
      notRuntimeVerifiedPairs: pairExecution.length - runtimeVerified.length,
      note: 'A pair is runtime-verified only when both scenarios pass, the actual instrumented decision outcome matches, the target atom is observed with its expected value on both sides, all observed atoms match, and any short-circuited fixed atoms are independently confirmed by the concrete input check.',
    };
  }
  feedback.jest = {
    cwd: jestWorkingDirectory,
    exitCode: run.status,
    signal: run.signal ?? null,
    launchError: run.error?.message ?? null,
    stdoutTail: (run.stdout ?? '').slice(-6000),
    stderrTail: (run.stderr ?? '').slice(-6000),
    ...(coverageError ? { coverageError } : {}),
  };
  feedback.execution = {
    generatedCases: cases.length,
    testBatching: {
      strategy: args.testBatching === false ? 'individual-tests' : 'test.each',
      ...testBatchPlan.stats,
      batches: testBatchPlan.batches.map(batch => ({ id: batch.id, scenarioIds: batch.scenarioIds, size: batch.cases.length, signature: batch.signature })),
      individual: testBatchPlan.individual.map(item => ({ id: item.id, reason: item.batchReason ?? 'Batch size threshold not reached or incompatible execution signature.' })),
      diagnostics: testBatchPlan.diagnostics,
    },
    testResults,
    mcdcPairs: pairExecution,
    mcdcPairsInputVerified: pairExecution.filter(pair => pair.inputChecks.conditionFalse?.status === 'verified' && pair.inputChecks.conditionTrue?.status === 'verified').length,
    mcdcPairsRuntimeVerified: pairExecution.filter(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)).length,
    mcdcPairsFullyRuntimeInstrumented: pairExecution.filter(pair => pair.status === 'runtime-mcdc-verified').length,
    mcdcPairsWithBothScenariosPassed: pairExecution.filter(pair => pair.bothScenariosPassed).length,
    mcdcInputChecks: mcdcInputResults,
    mcdcRuntimeChecks: pairExecution.flatMap(pair => [
      { pairId: pair.pairId, side: 'conditionFalse', ...pair.runtimeChecks.conditionFalse },
      { pairId: pair.pairId, side: 'conditionTrue', ...pair.runtimeChecks.conditionTrue },
    ]),
    mcdcRuntimeTraces: mcdcRuntimeResults,
  };
  feedback.execution.scenarioCoverage = buildScenarioCoverageAttribution(cases, testResults, mcdcRuntimeResults, result.functions, pairExecution);
  if (coverageMap) feedback.coverageFile = coverageOutputFile;
  fs.rmSync(tempDirectory, { recursive: true, force: true });
  if (instrumentedSourcePath) fs.rmSync(instrumentedSourcePath, { force: true });
  return feedback;
}

  return { createCoverageFeedback };
}
