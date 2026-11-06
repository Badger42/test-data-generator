const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('30.5.2\n');
  process.exit(0);
}
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
// Inject it only for the generated file. NODE_PATH is deliberately not used:
// a real Jest installation must never shadow this test double.
const before = [];
const beforeEachHooks = [];
const after = [];
const tests = [];
const jestApi = {
  beforeAll: fn => before.push(fn),
  beforeEach: fn => beforeEachHooks.push(fn),
  afterAll: fn => after.push(fn),
  jest: { clearAllMocks: () => {
    globalThis.__BRANCH_SCENARIO_JEST_CLEAR_CALLS__ = (globalThis.__BRANCH_SCENARIO_JEST_CLEAR_CALLS__ || 0) + 1;
  } },
  test: Object.assign(
    (name, fn) => tests.push({ name, fn }),
    { each: rows => (title, fn) => rows.forEach(row => {
      const values = Array.isArray(row) ? row : [row];
      const renderedTitle = String(title).replace(/%s/g, String(values[0]));
      tests.push({ name: renderedTitle, fn: () => fn(...values) });
    }) },
  ),
  __run: async () => {
    let setupError;
    try { for (const fn of before) await fn(); } catch (error) { setupError = error; }
    const assertionResults = [];
    for (const item of tests) {
      try {
        if (setupError) throw setupError;
        for (const hook of beforeEachHooks) await hook();
        await item.fn();
        assertionResults.push({ fullName: item.name, title: item.name, status: 'passed', failureMessages: [] });
      } catch (error) {
        assertionResults.push({ fullName: item.name, title: item.name, status: 'failed', failureMessages: [error.stack || String(error)] });
      }
    }
    for (const fn of after) {
      try { await fn(); } catch (error) { assertionResults.push({ fullName: 'afterAll', title: 'afterAll', status: 'failed', failureMessages: [error.stack || String(error)] }); }
    }
    return assertionResults;
  },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@jest/globals' && parent?.filename === testFile) return jestApi;
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
try {
  require(testFile);
} finally {
  Module._load = originalLoad;
}

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
    jestClearAllMocksCalls: globalThis.__BRANCH_SCENARIO_JEST_CLEAR_CALLS__ ?? 0,
  }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
