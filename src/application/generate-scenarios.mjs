import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { loadTypescriptProject } from '../project/load-typescript-project.mjs';
import { discoverFunctions } from '../project/discover-functions.mjs';
import { writeJson, writeMinimalSuiteJson } from '../reporting/json-writer.mjs';
import { createReportBuilder } from '../reporting/report-builder.mjs';
import { assertGenerationReport } from '../reporting/report-schema.mjs';
import { createAnalysisReportBuilder } from '../reporting/analysis-report-builder.mjs';
import { assertAnalysisReport } from '../reporting/analysis-report-schema.mjs';
import { createAnalysisRunForm } from '../reporting/analysis-run-form.mjs';
import { assertAnalysisRunForm } from '../reporting/analysis-run-form-schema.mjs';
import { createFunctionAnalysisSession } from '../analysis/function-analysis-session.mjs';
import { createFunctionAnalyzerAdapter } from '../analysis/function-analyzer-adapter.mjs';
import { createTypeScriptDataFlowAnalyzer } from '../data-flow/data-flow-analyzer.mjs';
import { createDataFlowAnalyzerAdapter } from '../data-flow/data-flow-adapter.mjs';
import { groupEquivalentScenarios } from '../scenarios/scenario-grouper.mjs';


function thrownErrorDescriptor(statement, ts) {
  if (!statement) return null;
  if (ts.isThrowStatement(statement)) {
    const expression = statement.expression;
    if (expression && ts.isNewExpression(expression)) {
      const qualifiedName = expression.expression.getText(statement.getSourceFile()).split('.');
      const name = qualifiedName[qualifiedName.length - 1];
      return { name, source: expression.getText(statement.getSourceFile()) };
    }
    const source = expression?.getText(statement.getSourceFile()) ?? null;
    let value = expression;
    while (value && ts.isParenthesizedExpression(value)) value = value.expression;
    if (value && ts.isStringLiteralLike(value)) return { name: null, source, primitive: { type: 'string', value: value.text } };
    if (value && ts.isNoSubstitutionTemplateLiteral(value)) return { name: null, source, primitive: { type: 'string', value: value.text } };
    if (value && ts.isNumericLiteral(value)) {
      const numericValue = Number(value.text);
      if (Number.isFinite(numericValue)) return { name: null, source, primitive: { type: 'number', value: numericValue } };
    }
    if (value?.kind === ts.SyntaxKind.TrueKeyword) return { name: null, source, primitive: { type: 'boolean', value: true } };
    if (value?.kind === ts.SyntaxKind.FalseKeyword) return { name: null, source, primitive: { type: 'boolean', value: false } };
    if (value?.kind === ts.SyntaxKind.NullKeyword) return { name: null, source, primitive: { type: 'null', value: null } };
    if (value && ts.isIdentifier(value) && value.text === 'undefined') return { name: null, source, primitive: { type: 'undefined' } };
    if (value && ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand) &&
        (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken)) {
      const numericValue = Number(value.operand.text) * (value.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
      if (Number.isFinite(numericValue)) return { name: null, source, primitive: { type: 'number', value: numericValue } };
    }
    return { name: null, source, unverifiable: true };
  }
  if (ts.isBlock(statement)) {
    const last = statement.statements[statement.statements.length - 1];
    return thrownErrorDescriptor(last, ts);
  }
  if (ts.isIfStatement(statement) && statement.elseStatement) {
    const thenError = thrownErrorDescriptor(statement.thenStatement, ts);
    const elseError = thrownErrorDescriptor(statement.elseStatement, ts);
    return thenError && elseError && thenError.name === elseError.name
      ? { name: thenError.name, source: `both branches throw (${thenError.source}; ${elseError.source})` }
      : null;
  }
  return null;
}

function annotateExpectedThrowScenarios(functionResults, functionUnits, sourceFile, ts) {
  const ifNodes = [];
  function visit(node) {
    if (ts.isIfStatement(node)) ifNodes.push(node);
    ts.forEachChild(node, visit);
  }
  for (const unit of functionUnits) visit(unit.node);
  const locationKey = node => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
    return `${position.line + 1}:${position.character + 1}`;
  };
  const byLocation = new Map(ifNodes.map(node => [locationKey(node), node]));
  return functionResults.map(result => {
    const scenarios = (result.scenarios ?? []).map(scenario => {
      const target = scenario.target;
      if (target?.kind !== 'if' || typeof target.outcome !== 'boolean') return scenario;
      const statement = byLocation.get(`${target.line}:${target.column}`);
      if (!statement) return scenario;
      const branch = target.outcome ? statement.thenStatement : statement.elseStatement;
      const expectedException = thrownErrorDescriptor(branch, ts);
      return expectedException ? { ...scenario, expectedException } : scenario;
    });
    const mcdc = result.mcdc ? {
      ...result.mcdc,
      decisions: (result.mcdc.decisions ?? []).map(decision => {
        // Match the concrete AST decision, not its source text: identical
        // expressions may occur in different if-statements with different
        // throw behavior on either outcome.
        const statement = decision.kind === 'if'
          ? byLocation.get(`${decision.line}:${decision.column}`)
          : null;
        if (!statement) return decision;
        return {
          ...decision,
          conditions: (decision.conditions ?? []).map(condition => ({
            ...condition,
            independencePairs: (condition.independencePairs ?? []).map(pair => ({
              ...pair,
              scenarios: Object.fromEntries(Object.entries(pair.scenarios ?? {}).map(([side, scenario]) => {
                const branch = scenario?.decisionOutcome === true ? statement.thenStatement
                  : scenario?.decisionOutcome === false ? statement.elseStatement : null;
                const expectedException = thrownErrorDescriptor(branch, ts);
                return [side, expectedException ? { ...scenario, expectedException } : scenario];
              })),
            })),
          })),
        };
      }),
    } : result.mcdc;
    const annotated = { ...result, scenarios, ...(mcdc ? { mcdc } : {}) };
    // Preserve the session-owned, non-enumerable metadata consumed by report
    // aggregation and later Data Flow/coverage stages. Object spread drops it.
    for (const key of Object.getOwnPropertyNames(result)) {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (descriptor && !descriptor.enumerable) Object.defineProperty(annotated, key, descriptor);
    }
    return annotated;
  });
}

export function validateGenerateOptions(args) {
  if (!args.file) throw new Error('A source file is required.');
  if (!Number.isInteger(args.maxScenarios) || args.maxScenarios < 1) throw new Error('--max-scenarios must be a positive integer.');
  if (!Number.isInteger(args.coverageIterations) || args.coverageIterations < 1 || args.coverageIterations > 10) throw new Error('--coverage-iterations must be an integer from 1 to 10.');
  if (!Number.isFinite(args.coverageGoal) || args.coverageGoal < 0 || args.coverageGoal > 100) throw new Error('--coverage-goal must be between 0 and 100.');
  if (!['v8', 'babel'].includes(args.coverageProvider)) throw new Error('--coverage-provider must be either v8 or babel.');
  if (!['hybrid', 'legacy'].includes(args.constraintEngine ?? 'hybrid')) throw new Error('--constraint-engine must be hybrid or legacy (compatibility alias).');
  if (args.testBatching !== false && (!Number.isInteger(args.testBatchMinSize ?? 2) || (args.testBatchMinSize ?? 2) < 2)) throw new Error('--test-batch-min-size must be an integer >= 2.');
  if (!Number.isInteger(args.testBatchMaxSize ?? 100) || (args.testBatchMaxSize ?? 100) < (args.testBatchMinSize ?? 2)) throw new Error('--test-batch-max-size must be >= --test-batch-min-size.');
  if (args.mockBehaviorOverrides != null && (typeof args.mockBehaviorOverrides !== 'object' || Array.isArray(args.mockBehaviorOverrides))) throw new Error('mockBehaviorOverrides must be an object keyed by mock call identity.');
  if (!['shape', 'hash', 'include'].includes(args.analysisReportValueMode ?? 'shape')) throw new Error('--analysis-report-values must be shape, hash or include.');
  if (!Number.isInteger(args.analysisReportMaxScenarios ?? 500) || (args.analysisReportMaxScenarios ?? 500) < 1 || (args.analysisReportMaxScenarios ?? 500) > 5000) throw new Error('--analysis-report-max-scenarios must be an integer from 1 to 5000.');
  if (args.analysisReportOut != null && (typeof args.analysisReportOut !== 'string' || !args.analysisReportOut.trim())) throw new Error('--analysis-report-out requires a file path.');
  if (args.analysisReportFormOut != null && (typeof args.analysisReportFormOut !== 'string' || !args.analysisReportFormOut.trim())) throw new Error('--analysis-report-form-out requires a file path.')
}

/**
 * Application use case. All process interaction is supplied through runtime
 * callbacks so the use case can be embedded and tested without CLI globals.
 */
export function generateScenarios(args, runtime = {}) {
  const cwd = runtime.cwd ?? process.cwd();
  const log = runtime.log ?? console.log;
  const setExitCode = runtime.setExitCode ?? (code => { process.exitCode = code; });
  const { VERSION, analyzeFunction, formatLine, runIterativeCoverageFeedback } = runtime;
  if (!VERSION || typeof analyzeFunction !== 'function' || typeof formatLine !== 'function' || typeof runIterativeCoverageFeedback !== 'function') {
    throw new TypeError('generateScenarios requires version, analyzer, source formatter and coverage-feedback runtime ports.');
  }
  validateGenerateOptions(args);
  for (const [option, outputPath] of [
    ['--out', args.out], ['--minimal-suite-out', args.minimalSuiteOut],
    ['--analysis-report-out', args.analysisReportOut], ['--analysis-report-form-out', args.analysisReportFormOut],
  ]) {
    if (!outputPath) continue;
    const directory = path.dirname(path.resolve(cwd, outputPath));
    if (!fs.existsSync(directory)) throw new Error(`${option} output directory does not exist: ${directory}. Create it explicitly before running the generator.`);
  }

  const project = loadTypescriptProject({ file: args.file, configFile: args.tsconfig });
  const { checker, sourceFile, absoluteFile } = project;
  let functions = discoverFunctions(sourceFile, { relativeFile: project.relativeFile });
  if (args.functionName) functions = functions.filter(fn => fn.name === args.functionName);
  else if (!args.all && functions.length > 1) {
    log(`Found ${functions.length} functions. Specify --function <name> or use --all.`);
    log(`Available: ${functions.map(fn => fn.name).join(', ')}`);
    setExitCode(2);
    return { status: 'selection-required', functions: functions.map(fn => fn.name) };
  }
  if (!functions.length) throw new Error(args.functionName ? `Function not found: ${args.functionName}` : 'No supported functions found.');
  const selectedFunctionNodes = [...functions];
  const relativeSource = path.relative(cwd, absoluteFile).split(path.sep).join('/');

  const functionAnalyzerAdapter = createFunctionAnalyzerAdapter(analyzeFunction);
  const dataFlowAnalyzer = createTypeScriptDataFlowAnalyzer(project.compilerApi);
  const functionAnalyzer = createDataFlowAnalyzerAdapter(dataFlowAnalyzer, functionAnalyzerAdapter);
  const analysisSessions = functions.map(functionUnit => createFunctionAnalysisSession({
    sessionId: functionUnit.functionId,
    project,
    functionUnit,
    limits: {
      maxScenarios: args.maxScenarios,
      maxAlternatives: Math.min(512, Math.max(40, args.maxScenarios)),
      maxDepth: 4,
    },
    features: {
      generateMcdc: args.mcdc,
      constraintEngine: args.constraintEngine ?? 'hybrid',
      mockBehaviorOverrides: args.mockBehaviorOverrides ?? {},
      includeEvidence: args.includeEvidence === true,
    },
  }, functionAnalyzer));
  const analyzedFunctionResults = analysisSessions.map(session => session.analyze());
  const functionResults = annotateExpectedThrowScenarios(analyzedFunctionResults, functions, sourceFile, project.compilerApi);
  for (const analysis of functionResults) analysis.scenarioGroups = groupEquivalentScenarios(analysis.scenarios);

  const reportBuilder = createReportBuilder();
  const result = reportBuilder.build({
    version: VERSION,
    source: relativeSource,
    sourceLanguage: /\.tsx?$/i.test(absoluteFile) ? 'typescript' : 'javascript',
    generatedAt: new Date().toISOString(),
    limitations: [
      'Static MVP: generated scenarios are candidates; run the function and verify actual branch coverage with Jest/Istanbul.',
      ...(args.mcdc ? ['MC/DC mode uses unique-cause independence: for each atomic condition, a pair must differ only in that condition while the full decision changes. This is static candidate generation; execute and verify the pairs in the target runtime.'] : []),
      'JavaScript is supported via the TypeScript parser with allowJs. Without JSDoc, property types are inferred from comparisons, truthiness checks, switch cases, nested accesses and .length; inferredProperties reports confidence and evidence.',
      'Supported conditions: direct parameter paths, literals, truthiness, !, &&, ||, equality, numeric comparisons, and simple numeric comparisons between two input paths. Unknown truthy/falsy properties use boolean representatives unless nested access implies an object/array.',
      'Supported control flow: if/else, switch with literal cases, ternary expressions, for/for...of/for...in/while/do...while loops, plus break/continue path termination inside loops and switch clauses.',
      'Loop scenarios: for...of and for...in generate zero-, one- and multiple-iteration collection shapes; loop-body aliases are mapped to a representative first item. Classic for loops support literal counter initializers and simple increment/decrement steps; while/do...while support simple property constraints and local numeric counter cases.',
      'Loop analysis is an approximation: common break/continue transfers stop analysis of the current path; break inside switch exits the switch, while continue propagates to the enclosing loop. Labelled transfers, full iteration-state propagation and switch fallthrough are not modeled. Mutations to iterated collections, custom iterators, async iterator side effects, and complex counter updates are unsupported.',
      'Array callback support: forEach/map/flatMap/some/every/filter/find/findIndex/findLast/findLastIndex/sort/toSorted and reduce with inline callbacks and collections resolved to function input paths. Predicate callbacks support concise expressions and block callbacks with a single return; safe top-level const aliases are expanded before MC/DC analysis. Block callbacks with explicit if decisions also expand safe const aliases in their conditions. For predicates that use the callback index parameter, unique-cause MC/DC searches representative callback indexes 0 and 1 and can emit a cross-index independence pair; pair scenarios carry the actual iterationIndex. Only immutable const declarations with side-effect-free initializers are inlined; let/var, destructuring, reassignment, helper calls, getters and mutation-dependent values are not symbolically expanded. Direct find()/findLast() checks and comparisons with null/undefined are supported, as are findIndex()/findLastIndex() comparisons against numeric literals. sort()/toSorted() comparator callbacks use two distinct representative source elements; flat() propagates nested element paths through literal depths 0–3. some/every have representative match/no-match scenarios. flatMap chains support a direct array-property projection (for example group => group.passengers). flat() chains support default and literal depths 0–3. sort()/toSorted() comparator branches are analyzed with a two-element collection. reduce analyzes callback indexes through 2 with an initial value and through 3 without one, replaying up to two prior callback invocations over bounded candidate items. This is concrete interpretation, not general symbolic execution; unsupported reducer statements are not replaced with a fabricated initial accumulator state.',
      'Array pipeline data-flow (v0.15.0): each function reports arrayPipelines summaries with stage order, source/output aliases, object projections, upstream filter constraints and comparator-order assumptions. Branch scenarios carry arrayPipelineTrace and MC/DC callback contexts carry pipeline metadata. The analyzer materializes representative outputs for all source elements needed by downstream callbacks, including comparator pairs. This is a bounded representative mapping: flatMap uses one representative child per source item; flat() uses the first nested child per item; recognized sort comparators preserve mapping by constructing an input already in comparator order, not by simulating arbitrary sort permutations. Inspect arrayPipelines[].warnings and assumptions, and execute generated scenarios.',
      'Undefined values are encoded as {"$undefined":true}; omit the corresponding argument/property or hydrate this marker before calling the function.',
      ...(args.includeEvidence ? ['Per-scenario static Data Flow evidence is included only with --include-evidence; static evidence is candidate support, never runtime verification.'] : []),
      'Mock templates are type-derived suggestions. For Jest coverage feedback, configure project mocks in --jest-setup; the setup can read globalThis.__BRANCH_SCENARIO__ and globalThis.__BRANCH_SCENARIO_MOCKS__ or define globalThis.__BRANCH_SCENARIO_APPLY_MOCKS__.',
      ...(args.coverageFeedback ? ['Iterative Jest coverage feedback executes the accumulated scenario suite, reads Istanbul coverage-final.json, and performs bounded candidate expansion for uncovered static branch outcomes (up to --coverage-iterations passes). Branch counters are aggregated for the source file; they do not independently prove MC/DC atom values. Branch-to-Istanbul mapping is heuristic and unmapped targets may remain unresolved. --coverage-from loads an existing report without iterative execution.'] : []),
      ...(args.minimalSuite ? ['Minimal-suite mode attributes supported static branch outcomes to individual scenario cases using source-level runtime decision traces, then solves a bounded set-cover problem that preserves those outcomes and both sides of runtime-verified MC/DC pairs. Uninstrumented targets (notably switch clause dispatch) are retained conservatively. Exact minimum is proven only for the finite obligations and candidate cases collected from the generated suite; this is not a proof over all possible function inputs.'] : []),
    ],
    functions: functionResults.map((analysis, index) => ({
      ...analysis,
      sourceLocation: formatLine(sourceFile, functions[index].node),
    })),
    functionResults,
    constraintDiagnostics: args.constraintDiagnostics,
    constraintEngine: args.constraintEngine ?? 'hybrid',
  });

  const outputFile = path.resolve(args.out ?? `${absoluteFile.replace(/\.(?:tsx?|jsx?|mjs|cjs)$/i, '')}.scenarios.json`);
  if (args.coverageFeedback) {
    result.coverageFeedback = runIterativeCoverageFeedback(result, selectedFunctionNodes, absoluteFile, outputFile, args, checker, sourceFile);
  }
  if (args.minimalSuiteOut && result.coverageFeedback?.minimalTestSet) {
    const minimalOutputFile = path.resolve(args.minimalSuiteOut);
    writeMinimalSuiteJson(minimalOutputFile, result);
    result.coverageFeedback.minimalTestSet.exportFile = minimalOutputFile;
  }
  assertGenerationReport(result);
  writeJson(outputFile, result);

  let analysisReportFile = null;
  let analysisRunFormFile = null;
  if (args.analysisReport || args.analysisReportOut || args.analysisReportFormOut) {
    const analysisReportBuilder = createAnalysisReportBuilder();
    const analysisReport = analysisReportBuilder.build({
      project, report: result, functionResults, functionUnits: functions, sessions: analysisSessions, args,
      valueMode: args.analysisReportValueMode ?? 'shape',
      maxScenarios: args.analysisReportMaxScenarios ?? 500,
    });
    assertAnalysisReport(analysisReport);
    analysisReportFile = path.resolve(cwd, args.analysisReportOut ?? `${outputFile.replace(/\.json$/i, '')}.analysis-report.json`);
    const analysisReportBase = analysisReportFile.replace(/\.analysis-report\.json$/i, '').replace(/\.json$/i, '');
    analysisRunFormFile = path.resolve(cwd, args.analysisReportFormOut ?? `${analysisReportBase}.analysis-run-form.json`);
    if (analysisReportFile === outputFile || analysisRunFormFile === outputFile || analysisRunFormFile === analysisReportFile) throw new Error('Analysis report, execution form and generation report paths must be different.');
    const executionForm = createAnalysisRunForm({ analysisReport, functionResults, coverageFeedback: result.coverageFeedback ?? null });
    assertAnalysisRunForm(executionForm);
    const portableFormPath = path.relative(path.dirname(analysisReportFile), analysisRunFormFile).split(path.sep).join('/');
    analysisReport.externalExecution.executionForm.file = portableFormPath.startsWith('../') || path.isAbsolute(portableFormPath) ? path.basename(analysisRunFormFile) : portableFormPath;
    analysisReport.assistantHandoff.recommendedAttachments = [...new Set([...(analysisReport.assistantHandoff.recommendedAttachments ?? []), 'the filled execution results form'])];
    assertAnalysisReport(analysisReport);
    writeJson(analysisReportFile, analysisReport);
    writeJson(analysisRunFormFile, executionForm);
  }

  const scenarioCount = result.functions.reduce((total, fn) => total + fn.scenarios.length, 0);
  log(`Generated ${scenarioCount} scenarios for ${result.functions.length} function(s).`);
  if (args.mcdc) {
    const pairs = result.functions.reduce((total, fn) => total + (fn.mcdc?.independencePairsFound ?? 0), 0);
    const missing = result.functions.reduce((total, fn) => total + (fn.mcdc?.conditionsWithoutIndependencePair.length ?? 0), 0);
    log(`MC/DC: ${pairs} independence pair(s), ${missing} condition(s) without a feasible pair.`);
  }
  if (result.coverageFeedback) {
    log(`Coverage feedback: ${result.coverageFeedback.status}`);
    if (result.coverageFeedback.coverageFile) log(`Coverage JSON: ${result.coverageFeedback.coverageFile}`);
    if (result.coverageFeedback.iterative?.enabled) log(`Coverage iterations: ${result.coverageFeedback.iterative.iterations.length}; added scenarios: ${result.coverageFeedback.iterative.totalAdditionalScenarios}; stop: ${result.coverageFeedback.iterative.stopReason}.`);
    if (result.coverageFeedback.totals) log(`Jest branch coverage: ${result.coverageFeedback.totals.branches.covered}/${result.coverageFeedback.totals.branches.total} (${result.coverageFeedback.totals.branches.pct}%).`);
    if (result.coverageFeedback.execution?.scenarioCoverage) {
      const attribution = result.coverageFeedback.execution.scenarioCoverage;
      log(`Per-scenario attribution: ${attribution.casesWithBranchAttribution}/${attribution.totalCases} cases have runtime branch outcomes.`);
    }
    if (result.coverageFeedback.minimalTestSet) {
      const minimal = result.coverageFeedback.minimalTestSet;
      log(`Minimal suite: ${minimal.selectedCases ?? 0}/${minimal.candidateCases ?? 0} cases; algorithm: ${minimal.algorithm ?? minimal.status}; exact minimum proven: ${Boolean(minimal.exactMinimumProven)}.`);
    }
    if (!['passed', 'coverage-loaded'].includes(result.coverageFeedback.status)) setExitCode(1);
    if (result.coverageFeedback.jest?.exitCode != null && result.coverageFeedback.jest.exitCode !== 0) setExitCode(1);
  }
  log(`JSON: ${outputFile}`);
  if (analysisReportFile) log(`Analysis report: ${analysisReportFile}`);
  if (analysisRunFormFile) log(`Execution results form: ${analysisRunFormFile}`);
  for (const fn of result.functions) {
    log(`- ${fn.name}: ${fn.summary.branchOutcomesFound} branch outcomes, ${fn.summary.scenariosGenerated} scenarios, ${fn.summary.branchesWithUnsupportedExpressions} unsupported branch targets`);
  }
  return { status: 'generated', result, outputFile, analysisReportFile, analysisRunFormFile };
}
