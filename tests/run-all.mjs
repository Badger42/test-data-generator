import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(root, 'tests');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures') walk(absolute);
    } else if (entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== 'run-all.mjs') {
      files.push(path.relative(root, absolute));
    }
  }
}
walk(testsRoot);
files.sort();
const concurrency = Math.max(1, Math.min(3, Number(process.env.TEST_CONCURRENCY) || 3));
const failures = [];
let next = 0;
async function runOne(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, file)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ file, code: 1, stdout, stderr: `${stderr}\n${error.stack ?? error}` }));
    child.on('close', code => resolve({ file, code: code ?? 1, stdout, stderr }));
  });
}
async function worker() {
  while (true) {
    const index = next++;
    if (index >= files.length) return;
    const file = files[index];
    const result = await runOne(file);
    if (result.code === 0) process.stdout.write(`PASS ${file}\n`);
    else {
      failures.push(result);
      process.stderr.write(`FAIL ${file} (exit ${result.code})\n`);
      if (result.stdout) process.stderr.write(result.stdout.slice(-12000));
      if (result.stderr) process.stderr.write(result.stderr.slice(-12000));
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
if (failures.length) {
  process.stderr.write(`\n${failures.length}/${files.length} test files failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nAll ${files.length} test files passed (concurrency ${concurrency}).\n`);
}
