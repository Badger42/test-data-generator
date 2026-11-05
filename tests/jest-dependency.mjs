import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.devDependencies?.jest, '26.6.0', 'Jest 26.6.0 must be pinned in devDependencies.');
const require = createRequire(import.meta.url);
const jestPackagePath = require.resolve('jest/package.json', { paths: [root] });
const jestPackage = JSON.parse(fs.readFileSync(jestPackagePath, 'utf8'));
assert.equal(jestPackage.version, '26.6.0', `Expected installed Jest 26.6.0, found ${jestPackage.version}.`);
assert.ok(fs.existsSync(path.join(root, 'node_modules', 'jest', 'bin', 'jest.js')) || fs.existsSync(path.join(path.dirname(jestPackagePath), 'bin', 'jest.js')));
console.log('Jest dependency contract passed: jest@26.6.0 is pinned and installed.');
