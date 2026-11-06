import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.devDependencies?.jest, '30.5.2', 'Jest 30.5.2 must be pinned in devDependencies.');
assert.equal(manifest.engines?.node, '>=24.0.0', 'Node.js >=24.0.0 must be declared.');
const nodeMajor = Number(process.versions.node.split('.')[0]);
assert.ok(nodeMajor >= 24, `Node.js >=24.0.0 is required; current runtime is ${process.versions.node}.`);
const require = createRequire(import.meta.url);
let jestPackagePath;
try {
  jestPackagePath = require.resolve('jest/package.json', { paths: [root] });
} catch {
  assert.fail('Jest 30.5.2 is not installed. Run `npm install` in the generator directory before running the integration suite.');
}
const jestPackage = JSON.parse(fs.readFileSync(jestPackagePath, 'utf8'));
assert.equal(jestPackage.version, '30.5.2', `Expected installed Jest 30.5.2, found ${jestPackage.version}.`);
assert.ok(fs.existsSync(path.join(root, 'node_modules', 'jest', 'bin', 'jest.js')) || fs.existsSync(path.join(path.dirname(jestPackagePath), 'bin', 'jest.js')));
console.log('Jest dependency contract passed: jest@30.5.2 is pinned and installed; Node >=24 is declared.');
