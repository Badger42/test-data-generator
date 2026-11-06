import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/manifest.json'), 'utf8'));
assert.equal(manifest.baselineVersion, '0.18.0');
for (const item of manifest.files) {
  const file = path.join(root, item.path);
  assert.ok(fs.existsSync(file), `Missing golden fixture: ${item.path}`);
  const bytes = fs.readFileSync(file);
  // Git may check text fixtures out with CRLF on Windows. The baseline hashes
  // describe canonical LF content, so normalize line endings before checking.
  const canonicalBytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  assert.equal(canonicalBytes.length, item.bytes, `Golden fixture size changed: ${item.path}`);
  assert.equal(createHash('sha256').update(canonicalBytes).digest('hex'), item.sha256, `Golden fixture changed: ${item.path}`);
  if (item.path.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(canonicalBytes.toString('utf8')), `Invalid JSON fixture: ${item.path}`);
}
console.log(`Golden baseline: ${manifest.files.length} frozen fixture(s) verified.`);
