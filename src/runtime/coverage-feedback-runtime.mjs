import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createMcdcSourceInstrumenter } from '../mcdc/runtime/source-instrumenter.mjs';
import { createMcdcRuntimeRecorderSource } from '../mcdc/runtime/runtime-recorder.mjs';
import { verifyRuntimeMcdcSide } from '../mcdc/runtime/runtime-verifier.mjs';
import { createJestRunner } from '../execution/jest-runner.mjs';
import { collectCoverageExecutionCases } from '../execution/coverage-case-collector.mjs';
import { buildJestFeedbackTest } from '../execution/jest-test-harness.mjs';
import { readJestTestResults } from '../execution/test-result-reader.mjs';
import { readRuntimeTraceFile } from '../execution/runtime-trace-reader.mjs';
import { readIstanbulCoverage, summarizeCounterMap } from '../coverage/istanbul-reader.mjs';
import { createSourceMapNormalizer } from '../coverage/source-map-normalizer.mjs';
import { createBranchMapper } from '../coverage/branch-mapper.mjs';
import { createCoverageFeedbackBuilder } from '../coverage/coverage-feedback-builder.mjs';
import { buildScenarioCoverageAttribution } from '../coverage/scenario-attributor.mjs';
import { createCoverageFeedbackUseCase } from '../application/run-coverage-feedback.mjs';
import { createIterativeCoverageFeedbackUseCase } from '../application/run-iterative-coverage-feedback.mjs';
import { createTestSuiteMinimizer } from '../minimization/test-suite-minimizer.mjs';

/** Owns Jest/Istanbul/MC-DC runtime orchestration and Node process boundaries. */
export function createCoverageFeedbackRuntime({ ts, analyzeFunction }) {
  if (!ts || typeof analyzeFunction !== 'function') throw new TypeError('CoverageFeedbackRuntime requires TypeScript and analyzeFunction.');
const RUNTIME_MCDC_SYMBOL = 'branch-scenarios-generator.runtime-mcdc.v1';

function getScriptKindForRuntimeInstrumentation(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function findNodeForSourceRange(sourceFileNode, startOffset, endOffset) {
  let match = null;
  function visit(node) {
    if (node.getStart(sourceFileNode) === startOffset && node.end === endOffset) {
      match = node;
      return;
    }
    if (match || node.getStart(sourceFileNode) > startOffset || node.end < endOffset) return;
    ts.forEachChild(node, visit);
  }
  visit(sourceFileNode);
  return match;
}

function inspectRuntimeExpression(node) {
  let hasAwait = false;
  let hasYield = false;
  let hasDirectEval = false;
  function visit(current) {
    if (!current) return;
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isAwaitExpression(current)) hasAwait = true;
    if (ts.isYieldExpression(current)) hasYield = true;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'eval') hasDirectEval = true;
    ts.forEachChild(current, visit);
  }
  visit(node);
  let asyncContext = false;
  for (let current = node?.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      asyncContext = Boolean(current.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword));
      break;
    }
  }
  return { hasAwait, hasYield, hasDirectEval, asyncContext };
}

const instrumentMcdcSource = createMcdcSourceInstrumenter({
  ts,
  getScriptKindForRuntimeInstrumentation,
  findNodeForSourceRange,
  inspectRuntimeExpression,
});

const jestRunner = createJestRunner({ fs, path, process, spawnSync });
const sourceMapNormalizer = createSourceMapNormalizer({ fs, path });
const branchMapper = createBranchMapper({
  fs, path, canonicalCoveragePath: sourceMapNormalizer.canonicalCoveragePath,
});
const coverageFeedbackBuilder = createCoverageFeedbackBuilder({
  path,
  summarizeCounterMap,
  normalizeCoverageFileMap: branchMapper.normalizeCoverageFileMap,
  mapCoverageBranches: branchMapper.mapCoverageBranches,
  collectStaticBranchTargets: branchMapper.collectStaticBranchTargets,
});
const coverageFeedbackUseCase = createCoverageFeedbackUseCase({
  fs,
  path,
  process,
  runJest: jestRunner.run,
  collectCoverageExecutionCases,
  findJestRunner: jestRunner.findJestRunner,
  resolveJestWorkingDirectory: jestRunner.resolveJestWorkingDirectory,
  instrumentMcdcSource,
  buildJestFeedbackTest,
  runtimeRecorderSource: createMcdcRuntimeRecorderSource(),
  readJestTestResults,
  readIstanbulCoverage,
  remapCoverageMapForInstrumentedSource: sourceMapNormalizer.remapCoverageMapForInstrumentedSource,
  buildCoverageFeedback: coverageFeedbackBuilder.buildCoverageFeedback,
  readRuntimeTraceFile,
  verifyRuntimeMcdcSide,
  buildScenarioCoverageAttribution,
});
const createCoverageFeedback = coverageFeedbackUseCase.createCoverageFeedback;
const testSuiteMinimizer = createTestSuiteMinimizer();








const iterativeCoverageFeedbackUseCase = createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback,
  analyzeFunction,
  buildMinimalTestSet: testSuiteMinimizer.buildMinimalTestSet,
});
const runIterativeCoverageFeedback = iterativeCoverageFeedbackUseCase.runIterativeCoverageFeedback;

  return Object.freeze({ runIterativeCoverageFeedback, createCoverageFeedback });
}
