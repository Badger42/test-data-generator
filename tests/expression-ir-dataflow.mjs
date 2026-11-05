import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectTypescriptExpressionFacts } from '../src/data-flow/typescript-expression-facts.mjs';
import { generateScenarios } from '../src/application/generate-scenarios.mjs';
import * as analyzerRuntime from '../src/runtime/typescript-analysis-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'branch-scenarios.mjs');
const fixture = path.join(root, 'tests/fixtures/constraint-expression-dataflow.ts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-expression-dataflow-'));

function runFunction(functionName, outputPath) {
  const run = spawnSync(process.execPath, [cli, fixture, '--function', functionName, '--constraint-diagnostics', '--out', outputPath], {
    cwd: root, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(run.status, 0, `${functionName} CLI failed:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

try {
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true, checkJs: true,
    strict: true, skipLibCheck: true,
  });
  const sourceFile = program.getSourceFile(fixture);
  const checker = program.getTypeChecker();
  let classifyNode = null;
  const findFunction = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'classify') classifyNode = node;
    if (!classifyNode) ts.forEachChild(node, findFunction);
  };
  findFunction(sourceFile);
  assert.ok(classifyNode, 'typed data-flow fixture must expose classify');
  const dataFlowFacts = collectTypescriptExpressionFacts(classifyNode, ts, checker, sourceFile, { fileName: 'tests/fixtures/constraint-expression-dataflow.ts' });
  assert.deepEqual(dataFlowFacts.expressionFacts.map(item => item.alias).sort(), ['afterDiscount', 'net', 'subtotal']);
  assert.deepEqual(dataFlowFacts.expressionFacts.find(item => item.alias === 'net').dependencies, ['afterDiscount', 'fare.amount']);
  assert.equal(dataFlowFacts.mockBindingFacts[0].localName, 'fare');
  assert.equal(dataFlowFacts.mockBindingFacts[0].awaited, true);
  assert.ok(dataFlowFacts.mockBindingFacts[0].sourceSpan.startOffset >= 0);
  assert.equal(dataFlowFacts.mockBindingFacts[0].sourceSpan.file, 'tests/fixtures/constraint-expression-dataflow.ts');
  assert.ok(dataFlowFacts.expressionFacts[0].sourceSpan.startLine >= 1);
  let concatNode = null;
  const findConcat = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'classifyConcat') concatNode = node;
    if (!concatNode) ts.forEachChild(node, findConcat);
  };
  findConcat(sourceFile);
  assert.ok(concatNode, 'string concatenation fixture must be discovered');
  const concatFacts = collectTypescriptExpressionFacts(concatNode, ts, checker, sourceFile, { fileName: 'tests/fixtures/constraint-expression-dataflow.ts' });
  assert.equal(concatFacts.expressionFacts.some(item => item.alias === 'fullName'), false,
    'string concatenation must not be lowered into numeric Expression IR');

  const output = path.join(temp, 'report.json');
  // The service implementation lives in this fixture project, so it is not
  // auto-mocked. This test explicitly requests a mock to verify that solver
  // assignments still materialize into a deliberately overridden local call.
  const generated = generateScenarios({
    file: fixture,
    functionName: 'classify',
    all: false,
    maxScenarios: 20,
    coverageIterations: 1,
    coverageGoal: 100,
    coverageProvider: 'v8',
    constraintEngine: 'hybrid',
    constraintDiagnostics: true,
    out: output,
    mockBehaviorOverrides: {
      'pricing.getFare': { behavior: 'mockResolvedValue' },
    },
  }, { cwd: root, log: () => {}, setExitCode: () => {}, ...analyzerRuntime });
  assert.equal(generated.status, 'generated');
  const report = generated.result;
  const fn = report.functions.find(item => item.name === 'classify');
  assert.ok(fn, 'fixture function must be discovered');
  assert.ok(fn.scenarios.length >= 2, 'both comparison outcomes must produce scenarios');
  assert.ok(fn.scenarios.every(item => item.mocks?.some(mock => mock.call === 'pricing.getFare' && mock.behavior === 'mockResolvedValue')),
    'computed mock result must be materialized as mockResolvedValue');
  assert.ok(fn.scenarios.every(item => typeof item.mocks[0].resolvedValue.amount === 'number'),
    'the solver assignment for mock.amount must be projected into the mock result');

  for (const scenario of fn.scenarios) {
    const input = scenario.arguments[0];
    const fareAmount = scenario.mocks.find(mock => mock.call === 'pricing.getFare').resolvedValue.amount;
    const actual = input.unitPrice * input.quantity - input.discount + fareAmount > 100;
    assert.equal(actual, scenario.target.outcome, 'materialized arguments and mock result must satisfy the branch outcome');
  }
  assert.ok(report.constraintEngine.irAttempts > 0, 'expression branch must enter Constraint IR');
  assert.ok(report.constraintEngine.irSolved > 0, 'arithmetic expression must be solved by Constraint IR');
  assert.equal(report.constraintEngine.legacyFallback, 0, 'this supported arithmetic/mock fixture must not fall back to legacy');

  const mutableReport = runFunction('classifyMutable', path.join(temp, 'mutable.json'));
  assert.ok(mutableReport.constraintEngine.legacyFallback > 0,
    'mutable local expressions must remain visibly delegated to legacy');
  assert.equal(mutableReport.constraintEngine.irSolved, 0,
    'mutable local values must not be solved as independent synthetic input paths');

  const concatReport = runFunction('classifyConcat', path.join(temp, 'concat.json'));
  assert.ok(concatReport.constraintEngine.legacyFallback > 0,
    'string concatenation must remain outside numeric Expression IR');
  assert.equal(concatReport.constraintEngine.irSolved, 0,
    'string concatenation must not be evaluated with numeric addition semantics');
  console.log('Expression IR / Data Flow integration tests passed: immutable aliases, arithmetic expressions and mock-result materialization verified.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
