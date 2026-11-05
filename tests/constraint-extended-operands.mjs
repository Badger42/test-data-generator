import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'branch-scenarios.mjs');
const fixture = path.join(root, 'tests/fixtures/constraint-operands.ts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-extended-operands-'));

function run(name, engine) {
  const output = path.join(temp, `${name}.json`);
  const args = [cli, fixture, '--all', '--constraint-diagnostics', '--out', output];
  if (engine) args.splice(4, 0, '--constraint-engine', engine);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function counts(report) {
  const output = new Map();
  for (const fn of report.functions) for (const scenario of fn.scenarios) {
    const key = `${fn.name}::${scenario.target.condition}::${scenario.target.outcome}`;
    output.set(key, (output.get(key) ?? 0) + 1);
  }
  return output;
}

try {
  const hybrid = run('hybrid');
  const legacy = run('legacy', 'legacy');
  const hybridCounts = counts(hybrid);
  const legacyCounts = counts(legacy);
  // IR intentionally emits one representative per disjoint numeric/length
  // region. Legacy may emit multiple concrete points from one region, so this
  // migration gate compares reachability, not redundant representative counts.
  for (const key of legacyCounts.keys()) {
    assert.ok((hybridCounts.get(key) ?? 0) > 0, `missing hybrid witness for ${key}`);
  }
  for (const fnName of ['compareLimits', 'classifyLength', 'compareLengths']) {
    const conditions = [...hybridCounts.keys()].filter(key => key.startsWith(`${fnName}::`));
    assert.ok(conditions.some(key => key.endsWith('::true')), `${fnName} is missing a true outcome`);
    assert.ok(conditions.some(key => key.endsWith('::false')), `${fnName} is missing a false outcome`);
  }

  assert.ok(hybrid.constraintEngine.irSolved > 0);
  const fallbackText = Object.keys(hybrid.constraintEngine.fallbackReasons).join('\n');
  assert.doesNotMatch(fallbackText, /Path-to-path comparisons are represented|Length accessor requires|Length comparisons currently require/);

  for (const fn of hybrid.functions) {
    for (const scenario of fn.scenarios) {
      const args = scenario.arguments[0];
      const condition = scenario.target.condition;
      let actual;
      if (fn.name === 'compareLimits') actual = args.count < args.limit;
      else if (fn.name === 'classifyLength' && condition === 'input.items.length === 0') actual = args.items.length === 0;
      else if (fn.name === 'classifyLength') actual = args.items.length >= 2 && args.items.length < 4;
      else if (fn.name === 'compareLengths') actual = args.left.length <= args.right.length;
      else continue;
      assert.equal(actual, scenario.target.outcome, `${fn.name} generated a non-reaching witness for ${condition}`);
    }
  }

  console.log('Extended Constraint IR tests passed: numeric path-to-path, array/string length, reachable outcomes and concrete witness evaluation verified.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
