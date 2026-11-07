import assert from 'node:assert/strict';
import { createJestMockAdapter } from '../src/mocks/adapters/jest-mock-adapter.mjs';

function createFakeMock() {
  let implementation = () => undefined;
  const once = [];
  function mock(...args) {
    mock.mock.calls.push(args);
    const next = once.length ? once.shift() : implementation;
    return Reflect.apply(next, this, args);
  }
  mock.mock = { calls: [] };
  mock.mockReturnValue = value => { implementation = () => value; return mock; };
  mock.mockResolvedValue = value => { implementation = () => Promise.resolve(value); return mock; };
  mock.mockRejectedValue = value => { implementation = () => Promise.reject(value); return mock; };
  mock.mockImplementation = fn => { implementation = fn; return mock; };
  mock.mockReturnValueOnce = value => { once.push(() => value); return mock; };
  mock.mockResolvedValueOnce = value => { once.push(() => Promise.resolve(value)); return mock; };
  mock.mockRejectedValueOnce = value => { once.push(() => Promise.reject(value)); return mock; };
  mock.mockImplementationOnce = fn => { once.push(fn); return mock; };
  mock.mockClear = () => { mock.mock.calls.length = 0; return mock; };
  mock.mockReset = () => { mock.mock.calls.length = 0; once.length = 0; implementation = () => undefined; return mock; };
  return mock;
}

function createFakeJest() {
  const esm = [];
  const commonjs = [];
  const jestApi = {
    fn: createFakeMock,
    unstable_mockModule: async (moduleName, factory) => { esm.push({ moduleName, factory }); },
    mock: (moduleName, factory) => { commonjs.push({ moduleName, factory }); },
    requireActual: () => ({ preservedExport: 'actual' }),
  };
  return { jestApi, esm, commonjs };
}

const { jestApi, esm, commonjs } = createFakeJest();
const adapter = createJestMockAdapter();
const esmTarget = {
  version: 1, id: 'module:esm:remote-api:loadRemote', kind: 'module-export',
  support: 'automatic', moduleMode: 'esm', moduleSpecifier: 'remote-api',
  resolvedModulePath: './remote-api.mjs', exportPath: ['loadRemote'],
};
const setup = await adapter.prepare([esmTarget], jestApi, {
  resolveModule: (specifier, target) => '/project/' + specifier.replace(/^\.\//, ''),
});
assert.equal(setup.preparedModules, 1);
assert.equal(esm.length, 1);
assert.equal(esm[0].moduleName, '/project/remote-api.mjs');
const esmExports = await esm[0].factory();
assert.equal(typeof esmExports.loadRemote, 'function');

const first = {
  callId: 'getRemote', callExpression: 'getRemote', callSiteId: 'service.ts:10:20',
  mockTarget: esmTarget, behavior: 'mockResolvedValue', value: { active: true },
  callArguments: [{ index: 0, value: 'first', resolvedFromScenario: true }],
};
const second = {
  callId: 'getRemote', callExpression: 'getRemote', callSiteId: 'service.ts:30:40',
  mockTarget: esmTarget, behavior: 'mockResolvedValue', value: { active: false },
  callArguments: [{ index: 0, value: 'second', resolvedFromScenario: true }],
};
const applied = adapter.applyScenario([first, second], [], null, jestApi);
assert.deepEqual(applied.applied, ['module:esm:remote-api:loadRemote']);
assert.deepEqual(applied.appliedTargetIds, [esmTarget.id], 'adapter reports the exact mock targets applied to this scenario');
assert.deepEqual(await esmExports.loadRemote('first'), { active: true });
assert.deepEqual(await esmExports.loadRemote('second'), { active: false });
adapter.reset();
assert.equal(await esmExports.loadRemote('first'), undefined, 'reset should clear the previous test row implementation');

const unavailableAdapter = createJestMockAdapter();
const unavailableSetup = await unavailableAdapter.prepare([esmTarget], { fn: createFakeMock });
assert.deepEqual(unavailableSetup.unpreparedTargets, [esmTarget.id]);
assert.ok(unavailableSetup.diagnostics.some(item => item.code === 'JEST_ESM_MOCKING_UNAVAILABLE'));
assert.throws(() => unavailableAdapter.applyScenario([{
  callId: 'getRemote', callExpression: 'getRemote', mockTarget: esmTarget,
  behavior: 'mockResolvedValue', value: { active: true },
}], [], null, { fn: createFakeMock }), /No Jest mock registered/,
'module mocks must not silently fall back to the real dependency when Jest cannot prepare ESM mocking');

const unpatchableAdapter = createJestMockAdapter();
const unpatchableTarget = {
  version: 1, id: 'parameter:0:api:getUser', kind: 'object-member', support: 'automatic',
  parameterIndex: 0, receiverPath: ['api'], memberName: 'getUser',
};
assert.throws(() => unpatchableAdapter.applyScenario([{
  callId: 'api.getUser', callExpression: 'api.getUser', mockTarget: unpatchableTarget,
  behavior: 'mockReturnValue', value: 'must-not-use-real-dependency',
}], [null], null, jestApi), /No Jest mock registered/,
'dynamic targets that cannot be patched must fail rather than execute the real dependency');

const cjsTarget = {
  version: 1, id: 'module:commonjs:legacy:lookup', kind: 'module-export',
  support: 'automatic', moduleMode: 'commonjs', moduleSpecifier: 'legacy',
  exportPath: ['lookup'],
};
await adapter.prepare([cjsTarget], jestApi);
assert.equal(commonjs.length, 1);
const cjsExports = commonjs[0].factory();
assert.equal(cjsExports.preservedExport, 'actual');
assert.equal(typeof cjsExports.lookup, 'function');
assert.equal(cjsExports.__esModule, true);

const dependency = { api: { getUser() { return 'real'; } } };
const diTarget = {
  version: 1, id: 'parameter:0:api:getUser', kind: 'object-member', support: 'automatic',
  parameterIndex: 0, receiverPath: ['api'], memberName: 'getUser',
};
adapter.applyScenario([{
  callId: 'api.getUser', callExpression: 'api.getUser', mockTarget: diTarget,
  behavior: 'mockReturnValue', value: 'injected',
}], [dependency], null, jestApi);
assert.equal(dependency.api.getUser(), 'injected');
adapter.reset();
assert.equal(dependency.api.getUser(), 'real', 'DI target must be restored after each test');

const receiver = { find() { return 'original'; } };
const thisTarget = {
  version: 1, id: 'this::find', kind: 'this-member', support: 'automatic',
  receiverPath: [], memberName: 'find',
};
adapter.applyScenario([{
  callId: 'this.find', callExpression: 'this.find', mockTarget: thisTarget,
  behavior: 'mockReturnValue', value: 'replaced',
}], [], receiver, jestApi);
assert.equal(receiver.find(), 'replaced');
adapter.reset();
assert.equal(receiver.find(), 'original');

const previousFetch = globalThis.__BSG_MOCK_TARGET__ ?? null;
globalThis.__BSG_MOCK_TARGET__ = { read() { return 'native'; } };
try {
  const globalTarget = {
    version: 1, id: 'global:globalThis:__BSG_MOCK_TARGET__:read', kind: 'global-member',
    support: 'automatic', globalName: 'globalThis', receiverPath: ['__BSG_MOCK_TARGET__'], memberName: 'read',
  };
  adapter.applyScenario([{
    callId: 'globalThis.__BSG_MOCK_TARGET__.read',
    callExpression: 'globalThis.__BSG_MOCK_TARGET__.read',
    mockTarget: globalTarget, behavior: 'mockReturnValue', value: 'stubbed',
  }], [], null, jestApi);
  assert.equal(globalThis.__BSG_MOCK_TARGET__.read(), 'stubbed');
  adapter.reset();
  assert.equal(globalThis.__BSG_MOCK_TARGET__.read(), 'native');
} finally {
  if (previousFetch === null) delete globalThis.__BSG_MOCK_TARGET__;
  else globalThis.__BSG_MOCK_TARGET__ = previousFetch;
}

console.log('Jest mock adapter passed: ESM/CJS module preparation, per-call conditional values, DI/this/global patching and per-row reset.');
