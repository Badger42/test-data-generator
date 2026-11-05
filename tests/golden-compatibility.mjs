import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-v019-golden-'));
const outputFile = path.join(tempDir, 'actual.json');
try {
  const run = spawnSync(process.execPath, [
    path.join(root, 'branch-scenarios.mjs'),
    path.join(root, 'examples/passenger.js'),
    '--function', 'getPassengerCategory',
    '--mcdc',
    '--out', outputFile,
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const actual = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/passenger-category-v0.18.json'), 'utf8'));
  delete actual.generatedAt;
  delete actual.generator.version;
  delete expected.generatedAt;
  delete expected.generator.version;
  assert.deepEqual(actual, expected, 'Current modularization changed the frozen v0.18 generated JSON contract');
  console.log('Golden compatibility passed: Current output matches the frozen v0.18 result (excluding version/timestamp).');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
