import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.engines?.node, '>=14.17', 'this check protects the declared Node 14.17 minimum');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.isFile() && filename.endsWith('.mjs')) files.push(filename);
  }
}
walk(path.join(root, 'src'));
const incompatible = [];
for (const filename of files) {
  const source = fs.readFileSync(filename, 'utf8');
  if (/\.at\s*\(/.test(source)) incompatible.push(path.relative(root, filename));
}
assert.deepEqual(incompatible, [], 'production source must not use Array.prototype.at while Node >=14.17 remains supported');
console.log(`Node compatibility tests passed: ${files.length} production modules contain no Array.prototype.at usage.`);
