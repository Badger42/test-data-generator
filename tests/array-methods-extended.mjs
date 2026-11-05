import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'array-methods-extended.js');
const output = path.join(os.tmpdir(), `branch-scenarios-array-extended-${process.pid}.json`);
const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--out', output], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const fixtureModule = await import(`${pathToFileURL(fixture).href}?test=${process.pid}`);
  const fn = name => {
    const found = result.functions.find(entry => entry.name === name);
    assert.ok(found, `Missing ${name}`);
    return found;
  };
  const scenario = (functionResult, predicate, description) => {
    const found = functionResult.scenarios.find(predicate);
    assert.ok(found, `Missing scenario: ${description}`);
    return found;
  };
  const execute = (functionResult, item) => fixtureModule[functionResult.name](...item.arguments.map(revive));
  const assertNoRuntimeErrors = functionResult => {
    for (const item of functionResult.scenarios) assert.doesNotThrow(() => execute(functionResult, item), `${functionResult.name}: ${item.id}`);
  };

  const filter = fn('filterEnabledItems');
  assert.equal(filter.unsupportedBranches.length, 0, JSON.stringify(filter.unsupportedBranches));
  const enabled = scenario(filter, item => item.target.condition === 'item.enabled' && item.target.outcome === true, 'filter callback enabled');
  assert.equal(enabled.arguments[0].items[0].enabled, true);
  const score = scenario(filter, item => item.target.condition === 'item.score > 10' && item.target.outcome === true, 'filter callback score');
  assert.equal(score.arguments[0].items[0].enabled, false);
  assert.equal(score.arguments[0].items[0].score, 11);
  assert.ok(filter.scenarios.some(item => item.target.loopType === 'array-filter' && item.target.outcome === 'zero-callbacks'));
  assertNoRuntimeErrors(filter);

  const filterPredicate = fn('filterByPredicate');
  const active = scenario(filterPredicate, item => item.target.kind === 'array-predicate' && item.target.condition === 'item.active' && item.target.outcome === true, 'filter predicate true');
  const inactive = scenario(filterPredicate, item => item.target.kind === 'array-predicate' && item.target.condition === 'item.active' && item.target.outcome === false, 'filter predicate false');
  assert.equal(active.arguments[0].items[0].active, true);
  assert.equal(inactive.arguments[0].items[0].active, false);
  assertNoRuntimeErrors(filterPredicate);

  const find = fn('findFirstAdult');
  const findTrue = scenario(find, item => item.target.condition.startsWith('input.people.find') && item.target.outcome === true, 'find found');
  const findFalse = scenario(find, item => item.target.condition.startsWith('input.people.find') && item.target.outcome === false, 'find missing');
  assert.equal(execute(find, findTrue), 'found');
  assert.equal(execute(find, findFalse), 'missing');
  assertNoRuntimeErrors(find);

  const findOptional = fn('findOptionalValue');
  const findOptionalTrue = scenario(findOptional, item => item.target.condition.includes('.find(') && item.target.outcome === true, 'find comparison found');
  const findOptionalFalse = scenario(findOptional, item => item.target.condition.includes('.find(') && item.target.outcome === false, 'find comparison missing');
  assert.equal(execute(findOptional, findOptionalTrue), 'found');
  assert.equal(execute(findOptional, findOptionalFalse), 'missing');
  assertNoRuntimeErrors(findOptional);

  const findIndex = fn('findIndexOfSecondActive');
  const second = scenario(findIndex, item => item.target.condition.includes('findIndex') && item.target.outcome === true, 'findIndex found at second index');
  assert.equal(second.arguments[0].items.length, 2);
  assert.equal(second.arguments[0].items[0].active, false);
  assert.equal(second.arguments[0].items[1].active, true);
  assert.equal(execute(findIndex, second), true);
  assertNoRuntimeErrors(findIndex);

  const notFound = fn('findIndexNotFound');
  const notFoundScenario = scenario(notFound, item => item.target.condition.includes('findIndex') && item.target.outcome === true, 'findIndex -1');
  assert.equal(execute(notFound, notFoundScenario), true);
  assertNoRuntimeErrors(notFound);

  const reduce = fn('reduceActiveCount');
  assert.equal(reduce.unsupportedBranches.length, 0, JSON.stringify(reduce.unsupportedBranches));
  const reduceActive = scenario(reduce, item => item.target.condition === 'item.active' && item.target.outcome === true, 'reduce item active');
  assert.equal(reduceActive.arguments[0].items[0].active, true);
  const reduceScore = scenario(reduce, item => item.target.condition === 'item.score > 10' && item.target.outcome === true, 'reduce item score');
  assert.equal(reduceScore.arguments[0].items[0].active, false);
  assert.equal(reduceScore.arguments[0].items[0].score, 11);
  assertNoRuntimeErrors(reduce);

  const reduceNoInitial = fn('reduceWithoutInitial');
  const accumulatorPath = scenario(reduceNoInitial, item => item.target.condition === 'total > 10' && item.target.outcome === true, 'reduce seed accumulator branch');
  assert.ok(accumulatorPath.arguments[0].values.length >= 2);
  assert.ok(accumulatorPath.arguments[0].values[0] > 10);
  const currentValue = scenario(reduceNoInitial, item => item.target.condition === 'value > 5' && item.target.outcome === true, 'reduce current item branch');
  assert.ok(currentValue.arguments[0].values[1] > 5);
  assertNoRuntimeErrors(reduceNoInitial);

  const reduceSeed = fn('reduceWithObjectSeed');
  assert.equal(reduceSeed.unsupportedBranches.length, 0, JSON.stringify(reduceSeed.unsupportedBranches));
  const threshold = scenario(reduceSeed, item => item.target.condition === 'accumulator.threshold > 2' && item.target.outcome === true, 'reduce object accumulator path');
  assert.ok(threshold.arguments[0].seed.threshold > 2);
  assertNoRuntimeErrors(reduceSeed);

  console.log('Extended array-method tests passed: filter, find, findIndex and reduce (literal, object-path and implicit initial values).');
} finally {
  try { fs.unlinkSync(output); } catch { /* cleanup */ }
}
