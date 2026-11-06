import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const expectedJestVersion = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).devDependencies?.jest;
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const configuredJest = process.env.JEST_BIN;
function readCoverageFailureDiagnostics(reportFile) {
  try {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const feedback = report.coverageFeedback ?? {};
    return JSON.stringify({ status: feedback.status, jest: feedback.jest ?? null, testResults: feedback.execution?.testResults ?? null });
  } catch (error) { return `report unavailable: ${error.message}`; }
}
function findJest() {
  if (configuredJest) {
    const explicit = path.resolve(configuredJest);
    assert.ok(fs.existsSync(explicit), `JEST_BIN does not exist: ${explicit}`);
    return explicit;
  }
  const roots = [process.cwd(), projectDir];
  for (const root of roots) {
    let current = path.resolve(root);
    while (true) {
      for (const relative of ['node_modules/jest/bin/jest.js', 'node_modules/jest-cli/bin/jest.js']) {
        const candidate = path.join(current, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

const jestBin = findJest();
if (!jestBin) {
  throw new Error('Real Jest integration requires Jest 30.5.2. Run `npm install` in the generator repository or set JEST_BIN to an explicit Jest executable.');
}

if (!configuredJest) {
  const candidates = [
    path.join(path.dirname(jestBin), '..', 'package.json'),
    path.join(path.dirname(jestBin), 'package.json'),
  ];
  const resolvedPackage = candidates.find(candidate => fs.existsSync(candidate));
  if (resolvedPackage) {
    const installedVersion = JSON.parse(fs.readFileSync(resolvedPackage, 'utf8')).version;
    assert.equal(installedVersion, expectedJestVersion, `Generator integration expects Jest ${expectedJestVersion}, found ${installedVersion}. Set JEST_BIN to test another consuming-project version explicitly.`);
  }
}

const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-real-jest-')));
try {
  const sourceFile = path.join(tempDir, 'target.mjs');
  const configFile = path.join(tempDir, 'jest.config.cjs');
  const outputFile = path.join(tempDir, 'real-jest-coverage.json');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  fs.writeFileSync(sourceFile, `export function realJestTarget(input) {\n  if (input.enabled && input.score >= 10) return 'active';\n  return 'inactive';\n}\n`);
  fs.writeFileSync(configFile, `module.exports = {\n  rootDir: ${JSON.stringify(tempDir)},\n  transform: {},\n  testEnvironment: 'node',\n  testMatch: ['<rootDir>/**/*.test.cjs'],\n  collectCoverageFrom: ['*.mjs'],\n};\n`);

  const result = spawnSync(process.execPath, [
    cli, sourceFile,
    '--function', 'realJestTarget',
    '--mcdc',
    '--coverage-feedback',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', configFile,
    '--out', outputFile,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });

  assert.equal(result.status, 0, `Real Jest integration failed:\n${result.stdout}\n${result.stderr}\nCoverage diagnostics: ${readCoverageFailureDiagnostics(outputFile)}`);
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(report.coverageFeedback.status, 'passed');
  assert.ok(report.coverageFeedback.execution.testResults.numPassedTests > 0);
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.enabled, 'Expected source-level runtime MC/DC instrumentation.');
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.coveragePathRemapped, 'Expected instrumented coverage to be remapped to the original source path.');
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.decisionsInstrumented > 0);
  assert.ok(report.coverageFeedback.mcdc.runtimeInstrumentation.conditionsInstrumented > 0);
  assert.ok(report.coverageFeedback.execution.mcdcPairs.length > 0);
  assert.ok(report.coverageFeedback.execution.mcdcPairs.every(pair => ['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)));
  assert.ok(report.coverageFeedback.execution.mcdcRuntimeChecks.every(check => check.trace?.conditions?.[check.targetConditionId]?.evaluated === true));
  assert.equal(report.coverageFeedback.execution.testResults.numFailedTests, 0);
  assert.ok(report.coverageFeedback.totals.branches.total > 0);
  assert.ok(report.coverageFeedback.staticBranchTargets.length > 0);
  const mappedIfTargets = report.coverageFeedback.staticBranchTargets.filter(target => target.kind === 'if' && target.coverageBranchId);
  assert.ok(
    mappedIfTargets.length > 0,
    `Expected the real Jest Istanbul branch map to match the analyzed if statement. Targets: ${JSON.stringify(report.coverageFeedback.staticBranchTargets)}. Coverage entries: ${JSON.stringify(report.coverageFeedback.coverageBranchEntries)}. Remapping: ${JSON.stringify(report.coverageFeedback.mcdc.runtimeInstrumentation)}`,
  );
  assert.ok(mappedIfTargets.some(target => target.coverageStatus === 'covered' || target.coverageStatus === 'partially-covered'));
  assert.ok(fs.existsSync(report.coverageFeedback.coverageFile));

  // Exercise the per-scenario attribution and minimal-suite path with the same
  // real Jest installation; missing Jest is an explicit environment failure.
  const minimalOutput = path.join(tempDir, 'real-jest-minimal-suite.json');
  const minimalDataOutput = path.join(tempDir, 'real-jest-minimal-data.json');
  const minimalRun = spawnSync(process.execPath, [
    cli, sourceFile,
    '--function', 'realJestTarget',
    '--minimal-suite',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', configFile,
    '--minimal-suite-out', minimalDataOutput,
    '--out', minimalOutput,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });
  assert.equal(minimalRun.status, 0, `Real Jest minimal-suite integration failed:\n${minimalRun.stdout}\n${minimalRun.stderr}`);
  const minimalReport = JSON.parse(fs.readFileSync(minimalOutput, 'utf8'));
  const minimal = minimalReport.coverageFeedback.minimalTestSet;
  const scenarioCoverage = minimalReport.coverageFeedback.execution.scenarioCoverage;
  assert.ok(scenarioCoverage.casesWithBranchAttribution > 0);
  assert.equal(minimal.status, 'complete');
  assert.ok(minimal.selectedCases > 0);
  assert.ok(minimal.selectedCases <= minimal.candidateCases);
  assert.ok(fs.existsSync(minimalDataOutput));
  const minimalData = JSON.parse(fs.readFileSync(minimalDataOutput, 'utf8'));
  assert.deepEqual(minimalData.minimalTestSet.selectedCaseIds, minimal.selectedCaseIds);
  for (const pair of minimalReport.coverageFeedback.execution.mcdcPairs.filter(item => item.status.startsWith('runtime-mcdc-verified'))) {
    assert.ok(minimal.selectedCaseIds.includes(pair.conditionFalseCaseId));
    assert.ok(minimal.selectedCaseIds.includes(pair.conditionTrueCaseId));
  }

  // Exercise CommonJS module loading, the Babel coverage provider, and a
  // setup-file mock whose implementation must survive per-case mock cleanup.
  const cjsSource = path.join(tempDir, 'target.cjs');
  const setupFile = path.join(tempDir, 'coverage-feedback-setup.mjs');
  const cjsOutput = path.join(tempDir, 'real-jest-cjs-babel.json');
  const cjsConfigFile = path.join(tempDir, 'jest.cjs.config.cjs');
  fs.writeFileSync(cjsConfigFile, [
    'module.exports = {',
    '  rootDir: ' + JSON.stringify(tempDir) + ',',
    '  transform: {},',
    '  testEnvironment: \'node\',',
    '  testMatch: [\'<rootDir>/**/*.test.cjs\'],',
    '  collectCoverageFrom: [\'target.cjs\'],',
    '};',
  ].join(String.fromCharCode(10)));
  fs.writeFileSync(cjsSource, `function cjsCoverageTarget(input) {
  const setupMockValue = globalThis.__BSG_SETUP_MOCK__().toUpperCase();
  if (input.enabled && input.score >= 10) return setupMockValue;
  return setupMockValue;
}
module.exports = { cjsCoverageTarget };
`);
  fs.writeFileSync(setupFile, `import { jest } from '@jest/globals';
globalThis.__BSG_SETUP_MOCK__ = jest.fn(() => 'preserved');
`);
  const cjsRun = spawnSync(process.execPath, [
    cli, cjsSource,
    '--function', 'cjsCoverageTarget',
    '--coverage-feedback',
    '--coverage-provider', 'babel',
    '--jest-bin', jestBin,
    '--jest-config', cjsConfigFile,
    '--jest-setup', setupFile,
    '--out', cjsOutput,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });
  assert.equal(cjsRun.status, 0, `Real Jest CJS/Babel/setup-mock integration failed:
${cjsRun.stdout}
${cjsRun.stderr}
Coverage diagnostics: ${readCoverageFailureDiagnostics(cjsOutput)}`);
  const cjsReport = JSON.parse(fs.readFileSync(cjsOutput, 'utf8'));
  assert.equal(cjsReport.coverageFeedback.status, 'passed');
  assert.ok(cjsReport.coverageFeedback.totals.branches.total > 0, 'Babel coverage provider should report CJS branches');
  assert.ok(cjsReport.coverageFeedback.execution.testResults.numPassedTests > 1,
    'multiple generated cases must run while preserving the setup-file mock implementation');

  const falsyThrowSource = path.join(tempDir, 'falsy-throw.mjs');
  const falsyThrowOutput = path.join(tempDir, 'real-jest-falsy-throw.json');
  fs.writeFileSync(falsyThrowSource, `export function throwFalsy(input) {
  if (input.trigger) throw false;
  return 'ok';
}
`);
  const falsyThrowRun = spawnSync(process.execPath, [
    cli, falsyThrowSource,
    '--function', 'throwFalsy',
    '--coverage-feedback',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', configFile,
    '--out', falsyThrowOutput,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });
  assert.equal(falsyThrowRun.status, 0, `Real Jest falsy-throw integration failed:\n${falsyThrowRun.stdout}\n${falsyThrowRun.stderr}`);
  const falsyThrowReport = JSON.parse(fs.readFileSync(falsyThrowOutput, 'utf8'));
  assert.equal(falsyThrowReport.coverageFeedback.status, 'passed');
  assert.ok(falsyThrowReport.functions[0].scenarios.some(item => item.expectedException?.primitive?.type === 'boolean' && item.expectedException.primitive.value === false),
    'throw false branch must carry an exact primitive expectation');

  // TypeScript source loading via the consumer's Jest transform pipeline.
  const tsSource = path.join(tempDir, 'typed-target.ts');
  const tsTransformer = path.join(tempDir, 'typescript-transformer.cjs');
  const tsConfig = path.join(tempDir, 'jest.typescript.config.cjs');
  const tsOutput = path.join(tempDir, 'real-jest-typescript.json');
  const typescriptPath = require.resolve('typescript');
  fs.writeFileSync(tsSource, `export function typedTarget(input: { enabled: boolean; score: number }): string {
  if (input.enabled && input.score > 4) return 'active';
  return 'inactive';
}
`);
  fs.writeFileSync(tsTransformer, `const ts = require(${JSON.stringify(typescriptPath)});
module.exports = { process(source, filename) {
  const result = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }});
  return { code: result.outputText };
}};
`);
  fs.writeFileSync(tsConfig, `module.exports = {
  rootDir: __dirname,
  transform: { '^.+\\.tsx?$': ${JSON.stringify(tsTransformer)} },
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  testRegex: '.*\\.test\\.cjs$',
};
`);
  const tsRun = spawnSync(process.execPath, [
    cli, tsSource,
    '--function', 'typedTarget',
    '--coverage-feedback',
    '--coverage-provider', 'v8',
    '--jest-bin', jestBin,
    '--jest-config', tsConfig,
    '--out', tsOutput,
  ], { cwd: tempDir, encoding: 'utf8', env: { ...process.env } });
  assert.equal(tsRun.status, 0, `Real Jest TypeScript transform integration failed:\n${tsRun.stdout}\n${tsRun.stderr}`);
  const tsReport = JSON.parse(fs.readFileSync(tsOutput, 'utf8'));
  assert.equal(tsReport.coverageFeedback.status, 'passed');
  assert.ok(tsReport.coverageFeedback.totals.branches.total > 0, 'transformed TypeScript must contribute branch coverage');

  console.log(`Real Jest integration passed: ${report.coverageFeedback.execution.testResults.numPassedTests} ESM/V8 generated tests; ${report.coverageFeedback.totals.branches.covered}/${report.coverageFeedback.totals.branches.total} Istanbul branch counters covered; minimal suite ${minimal.selectedCases}/${minimal.candidateCases} cases; CJS/Babel/setup mock, TypeScript transform and falsy-throw compatibility passed.`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

