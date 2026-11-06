import assert from 'node:assert/strict';
import { createExecutionSignature } from '../src/testing/batching/execution-signature.mjs';
import { createTestBatchBuilder } from '../src/testing/batching/test-batch-builder.mjs';
import { renderJestEachRegistrations } from '../src/testing/batching/jest-each-generator.mjs';
import { buildJestFeedbackTest } from '../src/execution/jest-test-harness.mjs';

const makeCase = (id, mocks = [], extra = {}) => ({
  id, testName: `case ${id}`, arguments: [id], mocks, references: [], ...extra,
});
const methodA = { callId: 'service.getUser', callExpression: 'service.getUser', behavior: 'mockResolvedValue', value: { id: 1 } };
const methodB = { callId: 'service.getRole', callExpression: 'service.getRole', behavior: 'mockResolvedValue', value: 'admin' };
const builder = createTestBatchBuilder({ minBatchSize: 2, maxBatchSize: 2 });

const plan = builder.build([
  makeCase('a1', [methodA, methodB]),
  makeCase('a2', [{ ...methodB, value: 'reader' }, { ...methodA, value: { id: 2 } }]),
  makeCase('b1', [methodA]),
  makeCase('b2', [methodA]),
  makeCase('isolated', [methodA, methodB], { requiresDedicatedTest: true }),
], { functionName: 'getUser', setupProfileId: 'setup-A' });
assert.equal(plan.stats.inputCases, 5);
assert.equal(plan.stats.batchedCases, 4);
assert.equal(plan.stats.batchCount, 2);
assert.equal(plan.stats.individualCases, 1);
assert.deepEqual(plan.batches[0].scenarioIds, ['a1', 'a2']);
assert.deepEqual(plan.batches[1].scenarioIds, ['b1', 'b2']);

const sameMethodDifferentSites = builder.build([
  makeCase('site-a', [{ callId: 'service.lookup', callExpression: 'service.lookup', callSiteId: 'file.ts:10:25', behavior: 'mockResolvedValue', value: 1 }]),
  makeCase('site-b', [{ callId: 'service.lookup', callExpression: 'service.lookup', callSiteId: 'file.ts:90:105', behavior: 'mockResolvedValue', value: 2 }]),
]);
assert.equal(sameMethodDifferentSites.stats.batchedCases, 2, 'the same mocked method may batch across distinct source call sites when the setup registry uses method identity');
assert.equal(plan.individual[0].id, 'isolated');
const unnamed = builder.build([{ ...makeCase('auto-1', [methodA]), testName: undefined }, { ...makeCase('auto-2', [methodA]), testName: undefined }]);
assert.equal(unnamed.batches[0].cases[0].testName, '[Scenario] auto-1');
assert.ok(plan.diagnostics.some(item => item.caseId === 'isolated'));

const differentSetup = builder.build([
  makeCase('s1', [methodA], { setupProfileId: 'one' }),
  makeCase('s2', [methodA], { setupProfileId: 'two' }),
]);
assert.equal(differentSetup.batches.length, 0, 'different setup profiles must not share a test.each batch');
assert.equal(differentSetup.individual.length, 2);

const interleaved = builder.build([
  makeCase('first-1', [methodA]), makeCase('first-2', [methodA]),
  makeCase('middle', [methodB]),
  makeCase('last-1', [methodA]), makeCase('last-2', [methodA]),
]);
assert.deepEqual(interleaved.entries.map(entry => entry.kind), ['batch', 'individual', 'batch']);
const orderedRegistrations = renderJestEachRegistrations(interleaved);
assert.ok(orderedRegistrations.indexOf('BATCHES[0]') < orderedRegistrations.indexOf('case middle'));
assert.ok(orderedRegistrations.indexOf('case middle') < orderedRegistrations.indexOf('BATCHES[1]'));

const behaviorVariance = createExecutionSignature(makeCase('x', [{ ...methodA, behavior: 'sequence', sequence: [
  { behavior: 'mockResolvedValue', value: 1 },
] }])).batchable;
assert.equal(behaviorVariance, true, 'supported per-row mock behavior may vary inside a batch');
const unsupported = builder.build([
  makeCase('u1', [{ callId: 'service.x', behavior: 'customUnknown' }]),
  makeCase('u2', [{ callId: 'service.x', behavior: 'customUnknown' }]),
]);
assert.equal(unsupported.batches.length, 0);
assert.equal(unsupported.individual.length, 2);

const unsafeMockShapes = builder.build([
  makeCase('missing-identity-a', [{ behavior: 'mockResolvedValue', value: 1 }]),
  makeCase('missing-identity-b', [{ behavior: 'mockResolvedValue', value: 2 }]),
]);
assert.equal(unsafeMockShapes.batches.length, 0, 'mocks without stable call-site identity must not be grouped');
assert.equal(unsafeMockShapes.individual.length, 2);
const sentinelMockIdentity = builder.build([
  makeCase('sentinel-identity-a', [{ callId: 'unknown-call', behavior: 'mockResolvedValue', value: 1 }]),
  makeCase('sentinel-identity-b', [{ callId: 'unknown-call', behavior: 'mockResolvedValue', value: 2 }]),
]);
assert.equal(sentinelMockIdentity.batches.length, 0, 'the legacy unknown-call sentinel is not a stable method identity');

const nestedUnsupported = builder.build([
  makeCase('nested-sequence-a', [{ callId: 'service.getUser', behavior: 'sequence', sequence: [{ behavior: 'conditional', cases: [] }] }]),
  makeCase('nested-sequence-b', [{ callId: 'service.getUser', behavior: 'sequence', sequence: [{ behavior: 'conditional', cases: [] }] }]),
]);
assert.equal(nestedUnsupported.batches.length, 0, 'nested sequence/conditional actions are not valid leaf Jest mock steps');

const registrations = renderJestEachRegistrations(plan);
assert.match(registrations, /test\.each\(BATCHES\[0\]\.cases\.map\(scenario => \[/);
assert.match(registrations, /\)\('%s', async \(_testName, scenario\)/);
assert.match(registrations, /test\.each\(BATCHES\[1\]\.cases\.map\(scenario => \[/);
assert.match(registrations, /test\("case isolated \[scenario:isolated\]"/);

const cases = [makeCase('h1', [methodA]), makeCase('h2', [methodA])];
const generated = buildJestFeedbackTest('/tmp/target.js', 'target', null, '/tmp/in.json', '/tmp/run.json', [{ name: 'target' }], cases, '/* recorder */');
assert.match(generated, /const BATCHES =/);
assert.match(generated, /test\.each\(BATCHES\[0\]\.cases\.map\(scenario => \[/);
assert.match(generated, /async function runScenario\(scenario\)/);
assert.match(generated, /beforeEach\(async \(?\)? =>/);
assert.match(generated, /jestApi\.resetAllMocks\(\)/, 'test.each rows must reset Jest mocks before applying row-specific mock actions');
assert.match(generated, /__BRANCH_SCENARIO_RESET_MOCKS__/);
assert.ok(generated.indexOf('jestApi.resetAllMocks()') < generated.indexOf('__BRANCH_SCENARIO_RESET_MOCKS__'), 'Jest resets all mocks before the optional project hook');
assert.doesNotMatch(generated, /for \(const scenario of CASES\)/);

const individualGenerated = buildJestFeedbackTest('/tmp/target.js', 'target', null, '/tmp/in.json', '/tmp/run.json', [{ name: 'target' }], cases, '/* recorder */', { enabled: false });
assert.doesNotMatch(individualGenerated, /test\.each\(/);
assert.match(individualGenerated, /test\("case h1 \[scenario:h1\]"/);

console.log('Test Batching tests passed: stable execution signatures, method-set grouping, per-row mock variance, isolation fallback, chunk limits and Jest test.each rendering.');
