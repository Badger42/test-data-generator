const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');

const args = process.argv.slice(2);
const value = prefix => args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
const coverageDir = value('--coverageDirectory=');
const resultsFile = value('--outputFile=');
const testIndex = args.indexOf('--runTestsByPath');
const testFile = testIndex >= 0 ? args[testIndex + 1] : null;

if (!coverageDir || !resultsFile || !testFile) {
  throw new Error('Missing expected Jest arguments');
}

const generatedSource = fs.readFileSync(testFile, 'utf8');
const batchesMatch = generatedSource.match(/const BATCHES = (\[[\s\S]*?\]);\r?\nconst INDIVIDUAL_CASES =/);
const individualMatch = generatedSource.match(/const INDIVIDUAL_CASES = (\[[\s\S]*?\]);\r?\nconst SOURCE_URL =/);
if (!batchesMatch || !individualMatch) throw new Error('Could not read generated test batches');
const generatedBatches = JSON.parse(batchesMatch[1]);
const generatedIndividual = JSON.parse(individualMatch[1]);
const generatedCases = [...generatedBatches.flatMap(batch => batch.cases), ...generatedIndividual];
const sourceUrlMatch = generatedSource.match(/const SOURCE_URL = ("[^"]+");/);
const mcdcPathMatch = generatedSource.match(/const MCDC_INPUT_CHECKS_FILE = ("[^"]+");/);
if (!sourceUrlMatch || !mcdcPathMatch) {
  throw new Error('Generated Jest adapter was malformed');
}
const sourceFile = fileURLToPath(JSON.parse(sourceUrlMatch[1]));
const mcdcResultsFile = JSON.parse(mcdcPathMatch[1]);

// A small Jest API shim executes the generated adapter hooks and each test.
// It is an integration test double, not a coverage instrumenter.
const mockModules = path.join(path.dirname(resultsFile), 'mock-node-modules');
const jestGlobalsDir = path.join(mockModules, '@jest', 'globals');
fs.mkdirSync(jestGlobalsDir, { recursive: true });
fs.writeFileSync(path.join(jestGlobalsDir, 'package.json'), JSON.stringify({ name: '@jest/globals', main: 'index.cjs', type: 'commonjs' }));
const shimSource = [
  "const before = [], beforeEachHooks = [], after = [], tests = [];",
  "module.exports = {",
  "  beforeAll: fn => before.push(fn),",
  "  beforeEach: fn => beforeEachHooks.push(fn),",
  "  afterAll: fn => after.push(fn),",
  "  jest: { resetAllMocks: () => { globalThis.__BRANCH_SCENARIO_JEST_RESET_CALLS__ = (globalThis.__BRANCH_SCENARIO_JEST_RESET_CALLS__ || 0) + 1; } },",
  "  test: Object.assign((name, fn) => tests.push({ name, fn }), { each: rows => (title, fn) => rows.forEach(row => tests.push({ name: title.replace(/\\$testName/g, row.testName), fn: () => fn(row) })) }),",
  "  __run: async () => {",
  "    let setupError;",
  "    try { for (const fn of before) await fn(); } catch (error) { setupError = error; }",
  "    const assertionResults = [];",
  "    for (const item of tests) {",
  "      try {",
  "        if (setupError) throw setupError;",
  "        for (const hook of beforeEachHooks) await hook();",
  "        await item.fn();",
  "        assertionResults.push({ fullName: item.name, status: 'passed', failureMessages: [] });",
  "      } catch (error) {",
  "        assertionResults.push({ fullName: item.name, status: 'failed', failureMessages: [error.stack || String(error)] });",
  "      }",
  "    }",
  "    for (const fn of after) {",
  "      try { await fn(); } catch (error) { assertionResults.push({ fullName: 'afterAll', status: 'failed', failureMessages: [error.stack || String(error)] }); }",
  "    }",
  "    return assertionResults;",
  "  },",
  "};",
].join('\n');
fs.writeFileSync(path.join(jestGlobalsDir, 'index.cjs'), shimSource, 'utf8');
process.env.NODE_PATH = [mockModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
const jestApi = require('@jest/globals');
require(testFile);

(async () => {
  const assertionResults = await jestApi.__run();
  const passed = assertionResults.filter(item => item.status === 'passed').length;
  const failed = assertionResults.length - passed;
  if (failed) console.error(JSON.stringify(assertionResults.filter(item => item.status !== 'passed'), null, 2));
  const mcdcResults = fs.existsSync(mcdcResultsFile)
    ? JSON.parse(fs.readFileSync(mcdcResultsFile, 'utf8'))
    : [];

  // Synthetic Istanbul-shaped fixture used only to validate JSON parsing and mapping.
  // Real branch counters are produced only by running the adapter under actual Jest.
  const isIterativeFixture = sourceFile.endsWith('coverage-feedback-iterative-target.js');
  const isMinimalSuiteFixture = sourceFile.endsWith('minimal-suite-target.js');
  const hasDeScenario = generatedCases.some(item => JSON.stringify(item.arguments).includes('\"region\":\"DE\"'));
  const branchMap = isMinimalSuiteFixture ? {
    0: {
      type: 'if',
      loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 52 } },
      locations: [
        { start: { line: 2, column: 45 }, end: { line: 2, column: 52 } },
        { start: { line: 2, column: 53 }, end: { line: 2, column: 65 } },
      ],
    },
    1: {
      type: 'if',
      loc: { start: { line: 3, column: 2 }, end: { line: 3, column: 28 } },
      locations: [
        { start: { line: 3, column: 29 }, end: { line: 3, column: 43 } },
        { start: { line: 4, column: 2 }, end: { line: 4, column: 20 } },
      ],
    },
  } : {
    0: {
      type: 'if',
      loc: isIterativeFixture
        ? { start: { line: 5, column: 2 }, end: { line: 7, column: 3 } }
        : { start: { line: 2, column: 2 }, end: { line: 2, column: 43 } },
      locations: [
        { start: { line: 2, column: 44 }, end: { line: 4, column: 3 } },
        { start: { line: 5, column: 2 }, end: { line: 5, column: 22 } },
      ],
    },
  };
  const coverage = {
    [sourceFile]: {
      path: sourceFile,
      statementMap: {},
      fnMap: {},
      branchMap,
      s: { 0: assertionResults.length ? 1 : 0 },
      f: { 0: assertionResults.length ? 1 : 0 },
      b: isMinimalSuiteFixture ? { 0: [1, 1], 1: [1, 1] } : { 0: isIterativeFixture ? [1, hasDeScenario ? 1 : 0] : [1, 1] },
      l: { 2: assertionResults.length ? 1 : 0 },
    },
  };

  fs.mkdirSync(coverageDir, { recursive: true });
  fs.writeFileSync(path.join(coverageDir, 'coverage-final.json'), JSON.stringify(coverage));
  fs.writeFileSync(resultsFile, JSON.stringify({
    success: failed === 0,
    numTotalTests: assertionResults.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: 0,
    testResults: [{ assertionResults }],
    mcdcInputChecks: mcdcResults,
    setupHookCalls: globalThis.__BRANCH_SCENARIO_SETUP_HOOK_CALLS__ ?? 0,
    jestResetAllMocksCalls: globalThis.__BRANCH_SCENARIO_JEST_RESET_CALLS__ ?? 0,
  }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
