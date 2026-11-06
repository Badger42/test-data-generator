import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.engines?.node, '>=24.0.0', 'the supported Node.js baseline is 24.0.0');
assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim(), '26');
assert.equal(fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim(), '26');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
assert.match(workflow, /node:\s*\[24,\s*26\]/, 'CI must exercise both supported Node.js LTS lines');

// The old Node 14-era restriction against Array.prototype.at is intentionally
// removed. CI runs this source tree on the declared Node 24/26 baseline, which
// is the authoritative syntax/runtime compatibility check.
console.log('Node compatibility contract passed: Node >=24 is declared; local version files and CI matrix agree.');
