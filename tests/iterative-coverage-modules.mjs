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


const v8RangeFeedback = {
  status: 'passed',
  totals: { branches: { covered: 2, total: 2, pct: 100 } },
  staticBranchTargets: [{
    id: 'v8-if',
    kind: 'if',
    coverageType: 'branch',
    coverageStatus: 'partially-covered',
    mappingStatus: 'v8-condition-range-only',
    outcomes: [
      { value: true, covered: null, coverageOutcomeIndex: null, scenarioIds: ['v8-true'] },
      { value: false, covered: null, coverageOutcomeIndex: null, scenarioIds: ['v8-false'] },
    ],
  }],
  execution: { generatedCases: 2, testResults: { numTotalTests: 2, numPassedTests: 2, numFailedTests: 0 } },
};
let v8FeedbackRuns = 0;
let v8AnalysisRuns = 0;
const v8UseCase = createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback() { v8FeedbackRuns += 1; return v8RangeFeedback; },
  analyzeFunction() { v8AnalysisRuns += 1; throw new Error('unverifiable V8 range must not trigger futile candidate expansion'); },
  buildMinimalTestSet() { return { status: 'complete' }; },
});
const v8Result = v8UseCase.execute({ functions: [{ scenarios: [] }] }, [{}], '/tmp/source.js', '/tmp/out.json', {
  maxScenarios: 2, coverageIterations: 3, coverageGoal: 100, mcdc: false,
}, {}, {});
assert.equal(v8FeedbackRuns, 1);
assert.equal(v8AnalysisRuns, 0);
assert.equal(v8Result.iterative.stopReason, 'coverage-goal-unverifiable-with-current-provider');
assert.equal(v8Result.iterative.aggregateGoalReached, true, 'the aggregate Istanbul percentage is still reported separately');
assert.equal(v8Result.iterative.staticBranchOutcomesVerified, false);
assert.equal(v8Result.iterative.goalReached, false, 'an aggregate 100% must not claim a verified static branch goal');
assert.deepEqual(v8Result.iterative.unverifiableStaticTargets, [{
  id: 'v8-if', coverageStatus: 'partially-covered', mappingStatus: 'v8-condition-range-only',
}]);

// A 100% aggregate percentage must not hide a measurable, uncovered semantic
// outcome. The feedback loop still generates a candidate and reruns the suite.
const aggregateFullButOutcomeMissing = {
  status: 'passed',
  totals: { branches: { covered: 4, total: 4, pct: 100 } },
  staticBranchTargets: [{
    id: 'babel-if', kind: 'if', coverageType: 'if', coverageStatus: 'partially-covered',
    outcomes: [
      { value: true, coverageOutcomeIndex: 0, covered: true, scenarioIds: ['babel-true'] },
      { value: false, coverageOutcomeIndex: 1, covered: false, scenarioIds: ['babel-false'] },
    ],
    coverageOutcomes: [{ covered: true }, { covered: false }],
  }],
  execution: { generatedCases: 1, testResults: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 } },
};
let measurableFeedbackRuns = 0;
let measurableAnalysisRuns = 0;
const measurableUseCase = createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback() {
    measurableFeedbackRuns += 1;
    return measurableFeedbackRuns === 1 ? aggregateFullButOutcomeMissing : {
      ...aggregateFullButOutcomeMissing,
      staticBranchTargets: [{
        ...aggregateFullButOutcomeMissing.staticBranchTargets[0],
        coverageStatus: 'covered',
        outcomes: aggregateFullButOutcomeMissing.staticBranchTargets[0].outcomes.map(item => ({ ...item, covered: true })),
        coverageOutcomes: [{ covered: true }, { covered: true }],
      }],
    };
  },
  analyzeFunction(_node, _source, _checker, maxScenarios) {
    measurableAnalysisRuns += 1;
    assert.equal(maxScenarios, 2);
    return { scenarios: [{ id: 'babel-false', arguments: [false], mocks: [], target: { branchId: 'babel-if', outcome: false } }], summary: {} };
  },
  buildMinimalTestSet() { return { status: 'complete' }; },
});
const measurableResult = { functions: [{ scenarios: [{ id: 'babel-true', arguments: [true], mocks: [], target: { branchId: 'babel-if', outcome: true } }] }] };
const measurableFeedback = measurableUseCase.execute(measurableResult, [{}], '/tmp/source.js', '/tmp/out.json', {
  maxScenarios: 1, coverageIterations: 3, coverageGoal: 100, mcdc: false,
}, {}, {});
assert.equal(measurableFeedbackRuns, 2);
assert.equal(measurableAnalysisRuns, 1);
assert.equal(measurableFeedback.iterative.stopReason, 'coverage-goal-reached');
assert.equal(measurableFeedback.iterative.aggregateGoalReached, true);
assert.equal(measurableFeedback.iterative.staticBranchOutcomesVerified, true);
assert.equal(measurableFeedback.iterative.goalReached, true);

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
