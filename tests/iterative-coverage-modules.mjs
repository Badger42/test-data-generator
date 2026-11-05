import assert from 'node:assert/strict';
import {
  collectUncoveredStaticOutcomeKeys,
  mergeExpandedFunctionAnalysis,
  summarizeCoverageIteration,
} from '../src/coverage/coverage-feedback-iteration.mjs';
import { createIterativeCoverageFeedbackUseCase } from '../src/application/run-iterative-coverage-feedback.mjs';

const firstFeedback = {
  status: 'passed',
  totals: { branches: { covered: 1, total: 2, pct: 50 } },
  staticBranchTargets: [{ id: 'branch-1', coverageType: 'if', coverageStatus: 'uncovered', outcomes: [
    { value: true, scenarioIds: ['s-true'] }, { value: false, scenarioIds: ['s-false'] },
  ] }],
  execution: { generatedCases: 1, testResults: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 } },
};
const uncovered = collectUncoveredStaticOutcomeKeys(firstFeedback);
assert.deepEqual([...uncovered].sort(), ['branch-1:false', 'branch-1:true']);
assert.equal(collectUncoveredStaticOutcomeKeys({ staticBranchTargets: [{ id: 'b', coverageStatus: 'covered', outcomes: [{ value: false }] }] }).size, 0);
assert.deepEqual(summarizeCoverageIteration(firstFeedback, 1, 2, 0), {
  iteration: 1, status: 'passed', generatedScenarioCount: 2, addedScenarioCount: 0,
  executedScenarioCount: 1,
  jestTests: { total: 1, passed: 1, failed: 0 },
  branchCoverage: { covered: 1, total: 2, pct: 50 }, staticTargets: null,
});

const previous = { scenarios: [{ id: 's-true', arguments: [true], mocks: [], target: { branchId: 'branch-1', outcome: true } }] };
const expanded = { scenarios: [
  { id: 's-true', arguments: [true], mocks: [], target: { branchId: 'branch-1', outcome: true } },
  { id: 's-false', arguments: [false], mocks: [], target: { branchId: 'branch-1', outcome: false } },
] };
const merged = mergeExpandedFunctionAnalysis(previous, expanded, uncovered, 2);
assert.equal(merged.scenarios.length, 2, 'existing candidates must not be duplicated');
assert.equal(merged.feedbackScenariosAdded, 1);
assert.equal(merged.scenarios[1].feedbackIteration, 2);

let feedbackRuns = 0;
let analysisRuns = 0;
const useCase = createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback() {
    feedbackRuns += 1;
    return feedbackRuns === 1 ? firstFeedback : {
      ...firstFeedback,
      totals: { branches: { covered: 2, total: 2, pct: 100 } },
      staticBranchTargets: [{ id: 'branch-1', coverageType: 'if', coverageStatus: 'covered', outcomes: [
        { value: true, scenarioIds: ['s-true'] }, { value: false, scenarioIds: ['s-false'] },
      ] }],
    };
  },
  analyzeFunction(_node, _source, _checker, maxScenarios, _mcdc, options) {
    analysisRuns += 1;
    assert.equal(maxScenarios, 2);
    assert.equal(options.coverageExpansion, true);
    return { scenarios: [
      { id: 's-false', arguments: [false], mocks: [], target: { branchId: 'branch-1', outcome: false } },
    ], summary: {} };
  },
  buildMinimalTestSet() { return { status: 'complete' }; },
});
const result = { functions: [{ scenarios: previous.scenarios }] };
const iterative = useCase.execute(result, [{}], '/tmp/source.js', '/tmp/out.json', {
  maxScenarios: 1, coverageIterations: 3, coverageGoal: 100, mcdc: false,
}, {}, {});
assert.equal(feedbackRuns, 2);
assert.equal(analysisRuns, 1);
assert.equal(result.functions[0].scenarios.length, 2);
assert.equal(iterative.iterative.stopReason, 'coverage-goal-reached');
assert.equal(iterative.iterative.totalAdditionalScenarios, 1);
assert.equal(iterative.iterative.iterations[1].addedScenarioCount, 1);

const external = createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback: () => ({ status: 'coverage-loaded' }),
  analyzeFunction() { throw new Error('external coverage must not run analysis'); },
  buildMinimalTestSet() { throw new Error('external coverage must not minimize aggregated data'); },
});
const externalResult = external.execute({ functions: [] }, [], '/tmp/source.js', '/tmp/out.json', {
  coverageFrom: 'coverage.json', minimalSuite: true, coverageIterations: 3,
}, {}, {});
assert.equal(externalResult.iterative.enabled, false);
assert.equal(externalResult.iterative.stopReason, 'external-coverage-is-read-only');
assert.equal(externalResult.minimalTestSet.status, 'unavailable');

console.log('Iterative coverage module tests passed: uncovered-outcome selection, merge deduplication, cumulative re-execution, stopping conditions and read-only external coverage.');
