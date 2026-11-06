import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendTail, assertNonEmptyTestFiles, parsePositiveInteger } from '../src/testing/test-runner-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(root, 'tests');
const files = [];
const concurrency = parsePositiveInteger(process.env.TEST_CONCURRENCY, 3, 'TEST_CONCURRENCY', 3);
const testFileTimeoutMs = parsePositiveInteger(process.env.TEST_FILE_TIMEOUT_MS, 240_000, 'TEST_FILE_TIMEOUT_MS', 900_000);
const outputLimit = 24_000;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['fixtures', 'golden'].includes(entry.name)) walk(absolute);
    } else if (entry.isFile() && entry.name.endsWith('.mjs') && entry.name !== 'run-all.mjs') {
      files.push(path.relative(root, absolute));
    }
  }
}
walk(testsRoot);
files.sort();
assertNonEmptyTestFiles(files, testsRoot);

const failures = [];
let next = 0;

async function runOne(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, file)], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else if (process.platform === 'win32' && child.pid) {
          const treeKiller = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore', windowsHide: true,
          });
          treeKiller.on('error', () => child.kill());
        } else child.kill();
      } catch { /* process may already have exited */ }
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else if (process.platform === 'win32' && child.pid) {
            const treeKiller = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
              stdio: 'ignore', windowsHide: true,
            });
            treeKiller.on('error', () => child.kill());
          } else child.kill();
        } catch { /* process may already have exited */ }
      }, 2_000);
      killTimer.unref?.();
    }, testFileTimeoutMs);
    timeout.unref?.();

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ file, ...result, timedOut });
    };

    child.stdout.setEncoding('utf8').on('data', chunk => { stdout = appendTail(stdout, chunk, outputLimit); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = appendTail(stderr, chunk, outputLimit); });
    child.on('error', error => finish({ code: 1, stdout, stderr: `${stderr}\n${error.stack ?? error}` }));
    child.on('close', code => finish({ code: timedOut ? 124 : (code ?? 1), stdout, stderr }));
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
      process.stderr.write(`${result.timedOut ? 'TIMEOUT' : 'FAIL'} ${file} (exit ${result.code})\n`);
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
if (failures.length) {
  process.stderr.write(`\n${failures.length}/${files.length} test files failed or timed out (concurrency ${concurrency}, per-file timeout ${testFileTimeoutMs}ms).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nAll ${files.length} test files passed (concurrency ${concurrency}).\n`);
}
