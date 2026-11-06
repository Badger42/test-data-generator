import assert from 'node:assert/strict';
import { appendTail, assertNonEmptyTestFiles, parsePositiveInteger } from '../src/testing/test-runner-config.mjs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(parsePositiveInteger(undefined, 3, 'TEST_CONCURRENCY'), 3);
assert.equal(parsePositiveInteger('1', 3, 'TEST_CONCURRENCY'), 1);
assert.equal(parsePositiveInteger('3', 3, 'TEST_CONCURRENCY', 3), 3);
for (const value of ['0', '-1', '0.5', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
  assert.throws(() => parsePositiveInteger(value, 3, 'TEST_CONCURRENCY'), /positive integer/);
}
assert.equal(appendTail('abcdef', 'XYZ', 5), 'efXYZ');
assert.equal(appendTail('', 'short', 20), 'short');
assert.deepEqual(assertNonEmptyTestFiles(['one.mjs'], 'tests'), ['one.mjs']);
assert.throws(() => assertNonEmptyTestFiles([], 'empty tests'), /refusing to report an empty successful run/);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const invalidRunner = spawnSync(process.execPath, [path.join(root, 'tests', 'run-all.mjs')], {
  cwd: root, encoding: 'utf8', env: { ...process.env, TEST_CONCURRENCY: '0.5' }, timeout: 10_000,
});
assert.notEqual(invalidRunner.status, 0, 'the aggregate runner must reject fractional concurrency before starting workers');
assert.match(invalidRunner.stderr, /TEST_CONCURRENCY must be a positive integer/);
console.log('Test runner configuration tests passed: invalid concurrency is rejected, timeouts are bounded, output is capped, and the aggregate runner fails fast.');
