import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.engines?.node, '>=24.0.0', 'the supported Node.js baseline is 24.0.0');
assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(), '26');
assert.equal(fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim(), '26');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
assert.match(workflow, /node:\s*\[24,\s*26\]/, 'CI must exercise both supported Node.js LTS lines');
assert.match(workflow, /os:\s*\[ubuntu-latest,\s*windows-latest\]/, 'CI must exercise Linux and Windows');
assert.match(workflow, /actions\/checkout@v7/);
assert.match(workflow, /actions\/setup-node@v7/);
assert.equal(typeof new AsyncLocalStorage().run, 'function', 'AsyncLocalStorage is required for callback MC/DC isolation');

// Validate the platform API used by runtime MC/DC in addition to metadata and CI matrix.
console.log('Node compatibility contract passed: Node >=24, AsyncLocalStorage, Node 24/26 and Ubuntu/Windows CI are declared.');
