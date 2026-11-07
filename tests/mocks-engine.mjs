import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createDependencyDiscovery } from '../src/mocks/dependency-discovery.mjs';
import { createMockTemplateBuilder } from '../src/mocks/mock-template-builder.mjs';
import { createMockStatePlanner } from '../src/mocks/mock-state-planner.mjs';
import { createMockPlanner } from '../src/mocks/mock-planner.mjs';
import { createJestMockAdapter } from '../src/mocks/adapters/jest-mock-adapter.mjs';
import { createMockReportAdapter } from '../src/reporting/mock-report-adapter.mjs';
import { createAssignmentMaterializer } from '../src/scenarios/assignment-materializer.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mock-planner-fixture.ts', import.meta.url));
const program = ts.createProgram([fixture], { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext });
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(fixture);
const functionNode = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildTicket');
assert.ok(functionNode);
const unwrap = node => {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current))) current = current.expression;
  return current;
};

const discovery = createDependencyDiscovery(ts);
const statePlanner = createMockStatePlanner();
const templateBuilder = createMockTemplateBuilder({
  unionMembers: type => type?.isUnion?.() ? type.types : [type],
  defaultValueForType: type => {
    if (type.flags & ts.TypeFlags.NumberLike) return 0;
    if (type.flags & ts.TypeFlags.StringLike) return '';
    if (type.flags & ts.TypeFlags.BooleanLike) return false;
    if (checker.isArrayType(type)) return [];
    if (type.flags & ts.TypeFlags.Object) {
      const value = {};
      for (const property of checker.getPropertiesOfType(type)) {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? type.symbol?.declarations?.[0]);
        if (propertyType.flags & ts.TypeFlags.NumberLike) value[property.getName()] = 0;
        else if (propertyType.flags & ts.TypeFlags.StringLike) value[property.getName()] = '';
      }
      return value;
    }
    return {};
  },
});
const planner = createMockPlanner({ dependencyDiscovery: discovery, templateBuilder, statePlanner });
const discovered = planner.discover({
  functionNode, checker, sourceFile, unwrap, relativeFile: 'tests/fixtures/mock-planner-fixture.ts',
});

assert.deepEqual([...discovered.bindings.keys()].sort(), ['fare', 'status']);
assert.equal(discovered.bindings.get('fare').awaited, true);
assert.equal(discovered.bindings.get('fare').isPromise, true);
assert.equal(discovered.bindings.get('fare').callExpression, 'pricing.getFare');
assert.ok(discovered.bindings.get('fare').callSiteId.startsWith('tests/fixtures/mock-planner-fixture.ts:'));
assert.equal(discovered.bindings.get('status').isPromise, false);
assert.equal(discovered.bindings.has('pending'), false, 'an un-awaited Promise root must not be treated as its resolved value');
assert.deepEqual(discovered.templates.map(item => item.call).sort(), ['pricing.getFare', 'pricing.getPending', 'pricing.getStatus']);
assert.deepEqual(discovered.templates.find(item => item.call === 'pricing.getFare').suggestedResolvedValues, [{ amount: 0, currency: '' }]);

const moduleTarget = {
  version: 1, id: 'module:esm:remote-api:isRemoteActive', kind: 'module-export',
  support: 'automatic', moduleMode: 'esm', moduleSpecifier: 'remote-api',
  exportPath: ['isRemoteActive'],
};
const syntheticBinding = {
  localName: '__bsg_call_result_10_20',
  call: 'isRemoteActive', callId: 'isRemoteActive', callExpression: 'isRemoteActive',
  callSiteId: 'service.mjs:10:20', isPromise: true, awaited: true,
  mockTarget: moduleTarget,
};
const materializedDirectCall = createAssignmentMaterializer({
  cloneValue: value => structuredClone(value),
}).materialize({
  baseArguments: [],
  parameterMap: new Map(),
  mockBindingMap: new Map([[syntheticBinding.localName, syntheticBinding]]),
  assignments: new Map([['direct-call', {
    path: [syntheticBinding.localName], value: true,
  }]]),
  getMockDefault: () => false,
});
assert.deepEqual(materializedDirectCall.mockAssignments[0].binding.mockTarget, moduleTarget,
  'solver-created direct-call bindings must retain the module target through the JSON-safe materialization boundary');

const mergedPlan = statePlanner.plan({ mockAssignments: [
  { localName: 'fareAmount', binding: { call: 'pricing.getFare', callId: 'pricing.getFare', callExpression: 'pricing.getFare', isPromise: true }, value: { amount: 120 } },
  { localName: 'fareCurrency', binding: { call: 'pricing.getFare', callId: 'pricing.getFare', callExpression: 'pricing.getFare', isPromise: true }, value: { currency: 'GBP' } },
] });
assert.equal(mergedPlan.actions.length, 1, 'different local roots for the same call identity must produce one planned mock action');
assert.deepEqual(mergedPlan.actions[0].value, { amount: 120, currency: 'GBP' });
assert.doesNotThrow(() => JSON.stringify(mergedPlan), 'MockPlan must not retain TypeScript compiler objects');

const bindings = new Map([
  ['fare', { localName: 'fare', call: 'pricing.getFare', callId: 'pricing.getFare', callExpression: 'pricing.getFare', isPromise: true, awaited: true, resolvedType: 'Fare' }],
  ['status', { localName: 'status', call: 'pricing.getStatus', callId: 'pricing.getStatus', callExpression: 'pricing.getStatus', isPromise: false, awaited: false }],
  ['counter', { localName: 'counter', call: 'pricing.next', callId: 'pricing.next', callExpression: 'pricing.next', isPromise: true, awaited: true }],
]);
const assignments = [
  { localName: 'fare', binding: bindings.get('fare'), value: { amount: 150, currency: 'EUR' } },
  { localName: 'status', binding: bindings.get('status'), value: 'active' },
  { localName: 'counter', binding: bindings.get('counter'), value: 3 },
];
const plan = planner.plan({
  mockAssignments: assignments,
  behaviorOverrides: {
    'pricing.getFare': {
      behavior: 'sequence',
      sequence: [
        { behavior: 'mockResolvedValue', value: { amount: 100, currency: 'EUR' } },
        { behavior: 'mockRejectedValue', error: { name: 'Error', message: 'network' } },
      ],
    },
    'pricing.getStatus': {
      behavior: 'conditional',
      cases: [
        { when: { args: ['active'] }, action: { behavior: 'mockReturnValue', value: 'active' } },
      ],
      default: { behavior: 'mockReturnValue', value: 'inactive' },
    },
    'pricing.next': { behavior: 'mockImplementation', handlerId: 'nextCounter' },
  },
});
assert.equal(plan.version, 1);
assert.equal(plan.actions.length, 3);
assert.equal(plan.actions.find(item => item.callId === 'pricing.getFare').behavior, 'sequence');
assert.equal(plan.actions.find(item => item.callId === 'pricing.getStatus').behavior, 'conditional');
assert.equal(plan.actions.find(item => item.callId === 'pricing.next').behavior, 'mockImplementation');

const reportAdapter = createMockReportAdapter();
const reportMocks = reportAdapter.project(plan);
assert.equal(reportMocks.find(item => item.call === 'pricing.getFare').behavior, 'sequence');
assert.equal(reportMocks.find(item => item.call === 'pricing.getStatus').behavior, 'conditional');
const scenarioMocks = planner.toScenarioMocks(plan);
assert.equal(scenarioMocks.find(item => item.callId === 'pricing.getFare').sequence.length, 2);

function fakeJestMock() {
  return {
    calls: [], implementation: null,
    mockReturnValue(value) { this.calls.push(['return', value]); },
    mockResolvedValue(value) { this.calls.push(['resolve', value]); },
    mockRejectedValue(value) { this.calls.push(['reject', value]); },
    mockImplementation(fn) { this.implementation = fn; this.calls.push(['implementation']); },
    mockReturnValueOnce(value) { this.calls.push(['returnOnce', value]); },
    mockResolvedValueOnce(value) { this.calls.push(['resolveOnce', value]); },
    mockRejectedValueOnce(value) { this.calls.push(['rejectOnce', value]); },
    mockImplementationOnce(fn) { this.calls.push(['implementationOnce']); this.implementation = fn; },
  };
}
const fareMock = fakeJestMock();
const statusMock = fakeJestMock();
const counterMock = fakeJestMock();
const jestAdapter = createJestMockAdapter({ handlers: { nextCounter: value => value + 1 } });
const applied = jestAdapter.apply(plan, new Map([
  ['pricing.getFare', fareMock], ['pricing.getStatus', statusMock], ['pricing.next', counterMock],
]));
assert.deepEqual(applied.applied, ['pricing.getFare', 'pricing.getStatus', 'pricing.next']);
assert.deepEqual(fareMock.calls, [
  ['resolveOnce', { amount: 100, currency: 'EUR' }],
  ['rejectOnce', { name: 'Error', message: 'network' }],
]);
assert.equal(statusMock.implementation('active'), 'active');
assert.equal(statusMock.implementation('other'), 'inactive');
assert.equal(counterMock.implementation(4), 5);
const reportMock = fakeJestMock();
jestAdapter.apply(reportAdapter.hydrate([{ call: 'pricing.getFare', behavior: 'mockResolvedValue', resolvedValue: { amount: 55 } }]), new Map([['pricing.getFare', reportMock]]));
assert.deepEqual(reportMock.calls, [['resolve', { amount: 55 }]], 'report adapter can hydrate existing report mocks into the new Jest adapter');
assert.throws(() => jestAdapter.apply(plan, new Map()), /No Jest mock registered/);

console.log('Mock Engine passed: dependency discovery, call identity, templates, JSON-safe plans, sequence/conditional behavior, Jest adapter and report projection.');
