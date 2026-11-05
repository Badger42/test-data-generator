import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'branch-scenarios.mjs');
const fixture = path.join(root, 'tests/fixtures/multi-witness.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-multi-witness-'));

function run(name, engine) {
  const output = path.join(temp, `${name}.json`);
  const args = [cli, fixture, '--function', 'classify', '--constraint-diagnostics', '--out', output];
  if (engine) args.splice(5, 0, '--constraint-engine', engine);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 90_000 });
  assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function outcomeCounts(report) {
  const counts = new Map();
  for (const scenario of report.functions[0].scenarios) {
    const key = `${scenario.target.condition}::${scenario.target.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

try {
  const hybrid = run('hybrid');
  const legacy = run('legacy', 'legacy');
  const hybridCounts = outcomeCounts(hybrid);
  const legacyCounts = outcomeCounts(legacy);

  for (const condition of [
    'input.age < 18 || input.age > 65',
    "input.enabled && (input.role === 'admin' || input.role === 'owner')",
    'item.score < 0 || item.score > 100',
    'person.age < 18 || person.age > 65',
  ]) {
    for (const outcome of [true, false]) {
      const key = `${condition}::${outcome}`;
      assert.equal(hybridCounts.get(key), legacyCounts.get(key), `witness count differs for ${key}`);
      assert.ok((hybridCounts.get(key) ?? 0) > 0, `missing witness for ${key}`);
    }
  }

  assert.ok(hybrid.constraintEngine.irSolutionCount > 0, 'multi-result branch generation must use Constraint IR');
  assert.equal(Object.keys(hybrid.constraintEngine.fallbackReasons).some(reason =>
    reason.includes('multiple disjunctive path alternatives')), false, 'multi-witness OR outcomes must not be delegated wholesale to legacy');
  assert.equal(Object.keys(hybrid.constraintEngine.fallbackReasons).some(reason =>
    reason.includes('input.role')), false, 'literal-union paths must be materialized with legal TypeScript values');

  const { classify } = await import(pathToFileURL(fixture).href);
  for (const scenario of hybrid.functions[0].scenarios) {
    const input = scenario.arguments[0];
    const condition = scenario.target.condition;
    if (condition === 'input.age < 18 || input.age > 65') {
      assert.equal(classify(input) === 'age-outlier', scenario.target.outcome);
    } else if (condition === "input.enabled && (input.role === 'admin' || input.role === 'owner')") {
      assert.equal(classify(input) === 'privileged', scenario.target.outcome);
    } else if (condition === 'item.score < 0 || item.score > 100') {
      const item = input.items[0];
      assert.ok(item, 'loop-body witness must materialize its representative item');
      assert.equal(item.score < 0 || item.score > 100, scenario.target.outcome);
    } else if (condition === 'person.age < 18 || person.age > 65') {
      const person = input.people[scenario.target.iterationIndex];
      assert.ok(person, 'callback witness must materialize its representative element');
      assert.equal(person.age < 18 || person.age > 65, scenario.target.outcome);
    }
  }

  console.log('Multi-witness branch tests passed: nested OR, typed literal unions, loop bodies, callback predicates, legacy witness cardinality and runtime outcomes verified.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
