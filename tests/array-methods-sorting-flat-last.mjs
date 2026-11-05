import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Polyfill ES2023/ES2022 array helpers for the project's Node.js 14 baseline.
// The analyzed application itself still needs these methods natively or via a polyfill.
if (!Array.prototype.findLast) {
  Object.defineProperty(Array.prototype, 'findLast', { value(callback, thisArg) {
    for (let index = this.length - 1; index >= 0; index -= 1) if (callback.call(thisArg, this[index], index, this)) return this[index];
    return undefined;
  } });
}
if (!Array.prototype.findLastIndex) {
  Object.defineProperty(Array.prototype, 'findLastIndex', { value(callback, thisArg) {
    for (let index = this.length - 1; index >= 0; index -= 1) if (callback.call(thisArg, this[index], index, this)) return index;
    return -1;
  } });
}
if (!Array.prototype.toSorted) {
  Object.defineProperty(Array.prototype, 'toSorted', { value(compareFn) { return [...this].sort(compareFn); } });
}

const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'array-methods-sorting-flat-last.js');
const output = path.join(os.tmpdir(), `branch-scenarios-sort-flat-last-${process.pid}.json`);
const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--mcdc', '--out', output], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const mod = await import(`${pathToFileURL(fixture).href}?test=${process.pid}`);
  const get = name => {
    const result = report.functions.find(entry => entry.name === name);
    assert.ok(result, `Missing function ${name}`);
    assert.equal(result.unsupportedBranches.length, 0, `${name}: ${JSON.stringify(result.unsupportedBranches)}`);
    assert.equal(result.mcdc.conditionsWithoutIndependencePair.length, 0, `${name}: ${JSON.stringify(result.mcdc.conditionsWithoutIndependencePair)}`);
    return result;
  };
  const execute = (fn, scenario) => mod[fn.name](...scenario.arguments.map(revive));
  const findScenario = (fn, condition, outcome, message) => {
    const found = fn.scenarios.find(item => item.target.condition.includes(condition) && item.target.outcome === outcome);
    assert.ok(found, `Missing ${message}`);
    return found;
  };
  const assertNoRuntimeErrors = fn => {
    for (const scenario of fn.scenarios) {
      assert.doesNotThrow(() => execute(fn, scenario), `${fn.name}: ${scenario.id}`);
    }
  };

  const findLast = get('findLastAdult');
  const findLastTrue = findScenario(findLast, 'findLast(', true, 'findLast found scenario');
  const findLastFalse = findScenario(findLast, 'findLast(', false, 'findLast not-found scenario');
  assert.equal(execute(findLast, findLastTrue), true);
  assert.equal(execute(findLast, findLastFalse), false);
  assertNoRuntimeErrors(findLast);

  const findLastIndex = get('findLastIndexSecondActive');
  const lastIndexTrue = findScenario(findLastIndex, 'findLastIndex(', true, 'findLastIndex found at index 1');
  assert.equal(lastIndexTrue.arguments[0].items.length, 2);
  assert.equal(lastIndexTrue.arguments[0].items[1].active, true);
  assert.equal(execute(findLastIndex, lastIndexTrue), true);
  const lastIndexFalse = findScenario(findLastIndex, 'findLastIndex(', false, 'findLastIndex not found / index false');
  assert.equal(execute(findLastIndex, lastIndexFalse), false);
  assertNoRuntimeErrors(findLastIndex);

  const findLastIndexNotFound = get('findLastIndexNotFound');
  const noMatch = findScenario(findLastIndexNotFound, 'findLastIndex(', true, 'findLastIndex === -1');
  assert.equal(execute(findLastIndexNotFound, noMatch), true);
  const hasMatch = findScenario(findLastIndexNotFound, 'findLastIndex(', false, 'findLastIndex has match');
  assert.equal(execute(findLastIndexNotFound, hasMatch), false);
  assertNoRuntimeErrors(findLastIndexNotFound);

  const sort = get('sortByPrice');
  const lessTrue = findScenario(sort, 'left.price < right.price', true, 'sort comparator less-than true');
  const lessFalse = findScenario(sort, 'left.price < right.price', false, 'sort comparator less-than false');
  assert.ok(lessTrue.arguments[0].items[0].price < lessTrue.arguments[0].items[1].price);
  assert.ok(lessFalse.arguments[0].items[0].price >= lessFalse.arguments[0].items[1].price);
  assert.equal(execute(sort, lessTrue), Math.min(...lessTrue.arguments[0].items.map(item => item.price)));
  assert.equal(execute(sort, lessFalse), Math.min(...lessFalse.arguments[0].items.map(item => item.price)));
  const equalTrue = findScenario(sort, 'left.price === right.price', true, 'sort comparator equality true');
  const equalFalse = findScenario(sort, 'left.price === right.price', false, 'sort comparator equality false');
  assert.equal(equalTrue.arguments[0].items[0].price, equalTrue.arguments[0].items[1].price);
  assert.notEqual(equalFalse.arguments[0].items[0].price, equalFalse.arguments[0].items[1].price);
  assertNoRuntimeErrors(sort);

  const toSorted = get('toSortedByPriority');
  const priorityTrue = findScenario(toSorted, 'left.priority > right.priority', true, 'toSorted comparator true');
  assert.ok(priorityTrue.arguments[0].items[0].priority > priorityTrue.arguments[0].items[1].priority);
  assert.deepEqual(execute(toSorted, priorityTrue), [...priorityTrue.arguments[0].items.map(item => item.priority)].sort((a, b) => b - a));
  const priorityFalse = findScenario(toSorted, 'left.priority > right.priority', false, 'toSorted comparator false');
  assert.ok(priorityFalse.arguments[0].items[0].priority <= priorityFalse.arguments[0].items[1].priority);
  assert.deepEqual(execute(toSorted, priorityFalse), [...priorityFalse.arguments[0].items.map(item => item.priority)].sort((a, b) => b - a));
  assertNoRuntimeErrors(toSorted);

  const flatFindLast = get('flatGroupsFindAdult');
  const flatTrue = findScenario(flatFindLast, 'person.age >= 18 && person.active', true, 'flat().findLast predicate true');
  assert.ok(Array.isArray(flatTrue.arguments[0].groups[0]));
  assert.ok(flatTrue.arguments[0].groups[0][0].age >= 18);
  assert.equal(execute(flatFindLast, flatTrue), true);
  const flatFalse = findScenario(flatFindLast, 'person.age >= 18 && person.active', false, 'flat().findLast predicate false');
  assert.equal(execute(flatFindLast, flatFalse), false);
  assertNoRuntimeErrors(flatFindLast);

  const flatDepthTwo = get('flatDepthTwoFindFlag');
  const depthTrue = findScenario(flatDepthTwo, 'item.flag === true', true, 'flat(2) predicate true');
  assert.equal(depthTrue.arguments[0].matrix[0][0][0].flag, true);
  assert.equal(execute(flatDepthTwo, depthTrue), true);
  const depthFalse = findScenario(flatDepthTwo, 'item.flag === true', false, 'flat(2) predicate false');
  assert.equal(execute(flatDepthTwo, depthFalse), false);
  assertNoRuntimeErrors(flatDepthTwo);

  const sortedThenSome = get('sortedThenSome');
  assert.equal(execute(sortedThenSome, findScenario(sortedThenSome, "item === 'active'", true, 'toSorted no-comparator true')), true);
  assert.equal(execute(sortedThenSome, findScenario(sortedThenSome, "item === 'active'", false, 'toSorted no-comparator false')), false);
  assertNoRuntimeErrors(sortedThenSome);

  const defaultSortedThenSome = get('defaultSortThenSome');
  assert.equal(execute(defaultSortedThenSome, findScenario(defaultSortedThenSome, "item === 'a'", true, 'sort no-comparator true')), true);
  assert.equal(execute(defaultSortedThenSome, findScenario(defaultSortedThenSome, "item === 'a'", false, 'sort no-comparator false')), false);
  assertNoRuntimeErrors(defaultSortedThenSome);

  const mcdcDecisions = report.functions.flatMap(fn => fn.mcdc.decisions);
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.method === 'findLast'), 'findLast callback MC/DC missing');
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.method === 'findLastIndex'), 'findLastIndex callback MC/DC missing');
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.method === 'sort'), 'sort comparator MC/DC missing');
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.method === 'toSorted'), 'toSorted comparator MC/DC missing');

  console.log(`Array method sorting/flat/last tests passed: ${report.functions.length} functions, ${report.functions.reduce((sum, fn) => sum + fn.scenarios.length, 0)} scenarios, ${report.functions.reduce((sum, fn) => sum + fn.summary.mcdcIndependencePairsFound, 0)} MC/DC pairs.`);
} finally {
  try { fs.unlinkSync(output); } catch { /* cleanup */ }
}
