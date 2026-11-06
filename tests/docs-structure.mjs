import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdownFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) walk(relative);
    else if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(relative);
  }
}
markdownFiles.push('README.md');
walk('docs');
walk('contracts');
walk('src');

const expected = [
  'README.md',
  'docs/README.md',
  'docs/architecture/ARCHITECTURE.md',
  'docs/architecture/SUBSYSTEMS.md',
  'docs/architecture/RELEASE_PLAN.md',
  'docs/architecture/VALIDATION_STATUS.md',
  'docs/releases/IMPLEMENTATION_HISTORY.md',
].sort();
assert.deepEqual(markdownFiles.sort(), expected, 'Markdown documentation must remain consolidated and indexed');
assert.equal(markdownFiles.filter(file => /(^|\/)IMPLEMENTED_.*\.md$/i.test(file)).length, 0,
  'individual IMPLEMENTED files must be summarized in docs/releases/IMPLEMENTATION_HISTORY.md');
const history = fs.readFileSync(path.join(root, 'docs/releases/IMPLEMENTATION_HISTORY.md'), 'utf8');
for (const version of ['0.19', '0.20', '0.27', '0.34', '0.39', '0.50', '0.60', '0.70', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.3', '1.0.0-rc.5', '1.0.0-rc.6', '1.0.0-rc.7']) {
  assert.ok(history.includes(version), `implementation history must cover ${version}`);
}
console.log(`Documentation structure passed (${markdownFiles.length} Markdown files, implementation history consolidated).`);
