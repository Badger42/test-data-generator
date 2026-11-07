import assert from 'node:assert/strict';
import { createUndefinedValueSerializer } from '../src/scenarios/serializers/undefined-value.mjs';
import { createAssignmentMaterializer } from '../src/scenarios/assignment-materializer.mjs';
import { createScenarioDeduplicator } from '../src/scenarios/scenario-deduplicator.mjs';
import { createScenarioEvidenceBuilder } from '../src/scenarios/scenario-evidence-builder.mjs';
import { createScenarioBuilder } from '../src/scenarios/scenario-builder.mjs';
import { createMockStatePlanner } from '../src/mocks/mock-state-planner.mjs';
import { createMockReportAdapter } from '../src/reporting/mock-report-adapter.mjs';
import { createScenarioReportAdapter } from '../src/reporting/scenario-report-adapter.mjs';
import { groupEquivalentScenarios } from '../src/scenarios/scenario-grouper.mjs';

const UNDEFINED = Symbol('undefined');
function cloneTestValue(value) {
  if (typeof value === 'symbol' || value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneTestValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTestValue(item)]));
}
const undefinedSerializer = createUndefinedValueSerializer({ undefinedValue: UNDEFINED });
const marker = undefinedSerializer.serialize(UNDEFINED);
assert.deepEqual(marker, { $undefined: true });
assert.equal(undefinedSerializer.deserialize(marker), undefined);
assert.deepEqual(undefinedSerializer.serialize({ optional: UNDEFINED, nested: [1, UNDEFINED] }), {
  optional: { $undefined: true }, nested: [1, { $undefined: true }],
});
assert.throws(() => {
  const circular = {}; circular.self = circular;
  undefinedSerializer.serialize(circular);
}, /cyclic/);

const materializer = createAssignmentMaterializer({
  cloneValue: cloneTestValue,
  serializeValue: value => undefinedSerializer.serialize(value),
  isUndefined: value => value === UNDEFINED || value === undefined,
  materializeLengthConstraint: constraint => Array.from({ length: constraint.min }, () => 0),
  materializeNumericConstraint: constraint => constraint.representative,
});
const baseArguments = [{ profile: { name: 'base' }, rows: [] }, null];
const assignments = new Map([
  ['input.profile.age', { path: ['input', 'profile', 'age'], value: 36 }],
  ['input.rows.0.id', { path: ['input', 'rows', '0', 'id'], value: 'r1' }],
  ['input.optional', { path: ['input', 'optional'], value: UNDEFINED }],
  ['maybe', { path: ['maybe'], value: UNDEFINED }],
  ['input.limit', { path: ['input', 'limit'], numericConstraint: { representative: 9 } }],
  ['input.tags', { path: ['input', 'tags'], lengthConstraint: { min: 2 } }],
  ['fare.amount', { path: ['fare', 'amount'], value: 125 }],
  ['fare.currency', { path: ['fare', 'currency'], value: 'EUR' }],
]);
const materialized = materializer.materialize({
  baseArguments,
  assignments,
  parameterMap: new Map([['input', { index: 0, type: 'Input' }], ['maybe', { index: 1, type: 'string | undefined' }]]),
  localMockMap: new Map([['fare', { call: 'pricing.getFare', isPromise: true, resolvedType: 'Fare' }]]),
  getParameterDefault: () => ({}),
  getMockDefault: () => ({ amount: 0, currency: 'USD' }),
});
assert.deepEqual(materialized.arguments, [{
  profile: { name: 'base', age: 36 }, rows: [{ id: 'r1' }], limit: 9, tags: [0, 0],
}, { $undefined: true }]);
assert.deepEqual(materialized.mockAssignments, [{
  localName: 'fare',
  binding: { localName: 'fare', call: 'pricing.getFare', callId: 'pricing.getFare', callExpression: 'pricing.getFare', isPromise: true, awaited: false },
  value: { amount: 125, currency: 'EUR' },
}]);
const mockPlanner = createMockStatePlanner();
const mockPlan = mockPlanner.plan({ mockAssignments: materialized.mockAssignments });
const reportMocks = createMockReportAdapter().project(mockPlan);
assert.deepEqual(reportMocks, [{
  call: 'pricing.getFare', behavior: 'mockResolvedValue',
  resolvedValue: { amount: 125, currency: 'EUR' },
}]);
assert.deepEqual(baseArguments, [{ profile: { name: 'base' }, rows: [] }, null], 'materialization must not mutate base arguments');
assert.throws(() => materializer.materialize({
  baseArguments: [{}], assignments: [{ path: ['input', '__proto__', 'polluted'], value: true }],
  parameterMap: new Map([['input', { index: 0 }]]),
}), /unsafe/i);

const deduplicator = createScenarioDeduplicator();
const payloadA = { arguments: [{ id: 1 }], mocks: [{ call: 'service.fetch', behavior: 'mockResolvedValue', resolvedValue: { enabled: true } }] };
const payloadB = { arguments: [{ id: 1 }], mocks: [{ call: 'service.fetch', behavior: 'mockResolvedValue', resolvedValue: { enabled: false } }] };
assert.equal(deduplicator.claim(payloadA).duplicate, false);
assert.equal(deduplicator.claim(payloadA).duplicate, true);
assert.equal(deduplicator.claim(payloadB).duplicate, false, 'different mock result must not deduplicate with same arguments');
assert.equal(deduplicator.size(), 2);
assert.equal(deduplicator.claim({ arguments: [{ id: 1 }], mocks: [{ resolvedValue: { enabled: true }, behavior: 'mockResolvedValue', call: 'service.fetch' }] }).duplicate, true, 'object key order must not affect the fingerprint');

const evidenceBuilder = createScenarioEvidenceBuilder();
const evidence = evidenceBuilder.build({
  incoming: [{ assignments: new Map([['input.enabled', {}]]), unsupported: [] }],
  assignments: new Map([['fare.amount', {}]]),
  unsupported: ['unsupported expression'],
});
assert.deepEqual(evidence.assumptions, ['input.enabled', 'fare.amount']);
assert.equal(evidence.unsupported.length, 1);
assert.equal(evidence.warnings[0].code, 'constraint-unsupported');

const builder = createScenarioBuilder({ evidenceBuilder });
const scenario = builder.build({
  id: 'case-1', functionId: 'src/file.ts::fn@10',
  arguments: materialized.arguments,
  mocks: mockPlanner.toScenarioMocks(mockPlan),
  targets: [{ branchId: 'if-1', outcome: true }],
  incoming: [{ assignments: new Map([['input.profile.age', {}]]) }],
  assignments: new Map([['fare.amount', {}]]),
  unsupported: [],
});
assert.equal(scenario.functionId, 'src/file.ts::fn@10');
assert.equal(scenario.mocks[0].callId, 'pricing.getFare');
assert.equal(typeof scenario.fingerprint, 'string');
const reportScenario = createScenarioReportAdapter().project(scenario, {
  target: { branchId: 'if-1', outcome: true },
  mocks: reportMocks,
  unsupported: [],
});
assert.deepEqual(Object.keys(reportScenario), ['id', 'target', 'arguments', 'mocks', 'assumptions', 'unsupported']);
assert.deepEqual(reportScenario.mocks, reportMocks);

const grouped = groupEquivalentScenarios([
  { id: 'branch-a', arguments: [{ id: 7 }], mocks: [{ call: 'api.read', behavior: 'mockReturnValue', resolvedValue: { ok: true } }], target: { branchId: 'if-1', outcome: true } },
  { id: 'branch-b', arguments: [{ id: 7 }], mocks: [{ resolvedValue: { ok: true }, behavior: 'mockReturnValue', call: 'api.read' }], target: { branchId: 'if-2', outcome: false } },
  { id: 'branch-c', arguments: [{ id: 7 }], mocks: [{ call: 'api.read', behavior: 'mockReturnValue', resolvedValue: { ok: false } }], target: { branchId: 'if-3', outcome: true } },
]);
assert.equal(grouped.length, 1, 'only exact arguments + mocks duplicates are grouped');
assert.equal(grouped[0].size, 2);
assert.deepEqual(grouped[0].scenarioIds, ['branch-a', 'branch-b']);
assert.deepEqual(grouped[0].targets.map(item => item.branchId), ['if-1', 'if-2']);

console.log('Scenario modules passed: undefined serialization, assignment materialization, mock projection, fingerprinting, evidence and report compatibility.');
