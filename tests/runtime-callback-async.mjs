import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createMcdcRuntimeRecorderSource } from '../src/mcdc/runtime/runtime-recorder.mjs';

const require = createRequire(import.meta.url);
const context = vm.createContext({ require, console });
context.globalThis = context;
vm.runInContext(createMcdcRuntimeRecorderSource(), context, { filename: 'runtime-recorder.generated.cjs' });
const runtime = vm.runInContext("globalThis[Symbol.for('branch-scenarios-generator.runtime-mcdc.v1')]", context);

runtime.beginCase('parallel-case');
const parallelOutcomes = await Promise.all([
  runtime.runInCallback({ method: 'map', collection: 'items', iterationIndex: 0 }, async () => {
    await new Promise(resolve => setTimeout(resolve, 8));
    return runtime.decisionAsync('same-decision', async () => {
      await Promise.resolve();
      return runtime.condition('same-decision', 'enabled', () => true);
    });
  }),
  runtime.runInCallback({ method: 'map', collection: 'items', iterationIndex: 1 }, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    return runtime.decisionAsync('same-decision', async () => {
      await Promise.resolve();
      return runtime.condition('same-decision', 'enabled', () => false);
    });
  }),
]);
assert.deepEqual(parallelOutcomes, [true, false]);
const parallelRecords = runtime.snapshot().filter(record => record.caseId === 'parallel-case');
assert.equal(parallelRecords.length, 2, 'parallel decisions must produce two isolated traces');
assert.deepEqual(Array.from(parallelRecords, record => record.conditions.enabled.value).sort(), [false, true]);
assert.equal(new Set(parallelRecords.map(record => record.callbackContext.invocationId)).size, 2,
  'parallel callback invocations must retain distinct async-local identities');
assert.deepEqual(Array.from(parallelRecords, record => record.callbackContext.iterationIndex).sort(), [0, 1]);

let releaseLateCallback;
const lateCallbackBarrier = new Promise(resolve => { releaseLateCallback = resolve; });
const lateCallback = runtime.runInCallback({ method: 'map', collection: 'items', iterationIndex: 2 }, async () => {
  await lateCallbackBarrier;
  return runtime.decision('late-decision', () => runtime.condition('late-decision', 'enabled', () => true));
});
runtime.beginCase('next-case');
releaseLateCallback();
await lateCallback;
assert.equal(runtime.snapshot().some(record => record.caseId === 'next-case' && record.decisionId === 'late-decision'), false,
  'a callback that outlives its test case must not be attributed to the next scenario');

const currentResult = await runtime.runInCallback({ method: 'map', collection: 'items', iterationIndex: 3 }, async () => {
  await Promise.resolve();
  return runtime.decision('current-decision', () => runtime.condition('current-decision', 'enabled', () => true));
});
assert.equal(currentResult, true);
assert.equal(runtime.snapshot().filter(record => record.caseId === 'next-case' && record.decisionId === 'current-decision').length, 1);
console.log('Async callback MC/DC recorder tests passed: awaited contexts, parallel decision isolation, and cross-scenario leak prevention.');
