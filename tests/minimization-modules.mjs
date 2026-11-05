import assert from 'node:assert/strict';
import { buildCoverageObligationModel } from '../src/minimization/obligation-builder.mjs';
import { buildMinimalTestSet, createTestSuiteMinimizer } from '../src/minimization/test-suite-minimizer.mjs';

const cases = [
  { caseId: 'case-a', status: 'passed', testName: 'a', arguments: [true], mocks: [], references: [{ scenarioId: 's-a' }],
    coveredBranchOutcomes: [{ branchId: 'b1', outcome: true }], mcdcPairSides: [] },
  { caseId: 'case-b', status: 'passed', testName: 'b', arguments: [false], mocks: [], references: [{ scenarioId: 's-b' }],
    coveredBranchOutcomes: [{ branchId: 'b1', outcome: false }], mcdcPairSides: [] },
  { caseId: 'case-c', status: 'passed', testName: 'c', arguments: [1], mocks: [], references: [{ scenarioId: 's-c' }],
    coveredBranchOutcomes: [{ branchId: 'b1', outcome: true }], mcdcPairSides: [] },
  { caseId: 'case-failed', status: 'failed', testName: 'failed', arguments: [], mocks: [], references: [],
    coveredBranchOutcomes: [{ branchId: 'b2', outcome: true }], mcdcPairSides: [] },
];

const attribution = { cases };
const model = buildCoverageObligationModel(attribution, [], []);
assert.equal(model.cases.length, 3, 'failed tests must not become minimization candidates');
assert.deepEqual([...model.allObligationIds].sort(), ['branch:b1:false', 'branch:b1:true']);
assert.equal(model.caseCoverage.get('case-c').has('branch:b1:true'), true);

const minimal = buildMinimalTestSet(attribution, [], []);
assert.equal(minimal.status, 'complete');
assert.equal(minimal.exactMinimumProven, true);
assert.equal(minimal.selectedCases, 2);
assert.deepEqual(minimal.selectedCaseIds.sort(), ['case-a', 'case-b']);
assert.equal(minimal.removedCases, 1);

const limited = createTestSuiteMinimizer({ maxExactCandidates: 1 });
const greedy = limited.minimize(attribution, [], []);
assert.equal(greedy.exactMinimumProven, false);
assert.equal(greedy.algorithm, 'greedy-set-cover');
assert.equal(greedy.selectedCases, 2);

const searchLimited = buildMinimalTestSet(attribution, [], [], { maxSearchNodes: 1 });
assert.equal(searchLimited.exactMinimumProven, false, 'search-node cutoff must not claim an exact proof');
assert.equal(searchLimited.algorithm, 'greedy-set-cover-search-limit');
assert.equal(searchLimited.selectedCases, 2);

const mcdcCases = [
  { ...cases[0], caseId: 'false-side', coveredBranchOutcomes: [], mcdcPairSides: [{ pairId: 'p1', side: 'conditionFalse', verified: true }] },
  { ...cases[1], caseId: 'true-side', coveredBranchOutcomes: [], mcdcPairSides: [{ pairId: 'p1', side: 'conditionTrue', verified: true }] },
  { ...cases[2], caseId: 'extra', coveredBranchOutcomes: [], mcdcPairSides: [] },
];
const pair = { pairId: 'p1', decisionId: 'd1', conditionId: 'c1', conditionFalseCaseId: 'false-side', conditionTrueCaseId: 'true-side', status: 'runtime-mcdc-verified' };
const mcdcMinimal = buildMinimalTestSet({ cases: mcdcCases }, [], [pair]);
assert.equal(mcdcMinimal.mcdcPairsEligible, 1);
assert.equal(mcdcMinimal.mcdcPairsPreserved, 1);
assert.deepEqual(mcdcMinimal.selectedCaseIds.sort(), ['false-side', 'true-side']);

const fallbackTargets = [{ id: 'switch-1', kind: 'switch', outcomes: [
  { value: 'red', scenarioIds: ['s-a'] }, { value: 'blue', scenarioIds: ['s-b'] },
] }];
const fallback = buildMinimalTestSet(attribution, fallbackTargets, []);
assert.equal(fallback.status, 'complete-with-conservative-fallbacks');
assert.equal(fallback.conservativeFallbacks.length, 2);
assert.ok(fallback.conservativeFallbacks.every(item => item.evidence === 'switch-target-reference'));

const unavailable = buildMinimalTestSet(null, [], []);
assert.equal(unavailable.status, 'unavailable');
assert.throws(() => buildMinimalTestSet(attribution, [], [], { maxSearchNodes: 0 }), /positive integers/);

console.log('Minimization module tests passed: obligation IR, exact and greedy set cover, MC/DC preservation, conservative fallbacks, and unavailable inputs.');
