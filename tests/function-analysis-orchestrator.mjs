import assert from 'node:assert/strict';
import { createFunctionAnalysisOrchestrator } from '../src/analysis/function-analysis-orchestrator.mjs';

const calls = [];
let analyzerInstances = 0;
let stateSnapshot;
const orchestrator = createFunctionAnalysisOrchestrator({
  ts: { isBlock: node => node?.kind === 'block' },
  createFunctionContext(fn, sourceFile, checker, maxScenarios, generateMcdc, options) {
    return {
      fn, sourceFile, checker, maxScenarios, generateMcdc,
      analysisState: options.analysisState,
      parameters: [{ name: 'input' }],
      inferredProperties: [],
      mockTemplates: [],
    };
  },
  createControlFlowAnalyzer(ports) {
    analyzerInstances += 1;
    return {
      analyzeStatements(statements, initialPath, ctx) {
        calls.push({ statements, initialPath, ctx, ports });
        stateSnapshot = {
          branchCount: 1,
          scenarios: [{ id: 'scenario-1' }],
          unsupportedBranches: [],
          loopCount: 0,
          loopScenariosGenerated: 0,
          mcdcDecisions: [],
          mcdcConditions: 0,
          mcdcPairs: 0,
          mcdcConditionsWithoutPair: [],
          arrayPipelines: [],
          constraintStats: { irAttempts: 1 },
        };
      },
    };
  },
  createControlFlowPorts: ctx => ({ functionId: ctx.fn.name }),
  analyzeTernaries(node, incoming, ctx) {
    calls.push({ expression: node, incoming, ctx });
    stateSnapshot = {
      branchCount: 0, scenarios: [], unsupportedBranches: [], loopCount: 0,
      loopScenariosGenerated: 0, mcdcDecisions: [], mcdcConditions: 0,
      mcdcPairs: 0, mcdcConditionsWithoutPair: [], arrayPipelines: [], constraintStats: {},
    };
  },
  createFunctionAnalysisStateStore() {
    return { port: { snapshot: () => stateSnapshot } };
  },
  defaultMaxAlternatives: () => 40,
});

const first = orchestrator.analyzeFunction(
  { name: 'blockFunction', body: { kind: 'block', statements: ['if-statement'] } },
  {}, {}, 8, true, {},
);
assert.equal(first.summary.branchOutcomesFound, 1);
assert.equal(first.summary.scenariosGenerated, 1);
assert.equal(first.summary.mcdcDecisionsAnalyzed, 0);
assert.deepEqual(first._constraintStats, { irAttempts: 1 });
assert.equal(analyzerInstances, 1);
assert.equal(calls[0].statements[0], 'if-statement');
assert.deepEqual(calls[0].initialPath, [{ assignments: new Map(), unsupported: [] }]);

const expression = { kind: 'conditional-expression' };
const second = orchestrator.analyzeFunction(
  { name: 'expressionFunction', body: expression },
  {}, {}, 8, false, {},
);
assert.equal(second.summary.branchOutcomesFound, 0);
assert.equal(analyzerInstances, 2, 'each function must receive its own control-flow analyzer');
assert.equal(calls[1].expression, expression);
assert.deepEqual(calls[1].incoming, [{ assignments: new Map(), unsupported: [] }]);
console.log('Function analysis orchestrator passed: per-function traversal lifecycle and reducer-backed result projection are isolated.');
