import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'control-flow-and-array-methods.js');
const output = path.join(os.tmpdir(), `branch-scenarios-control-flow-${process.pid}.json`);

const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--out', output], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const fixtureModule = await import(`${pathToFileURL(fixture).href}?test=${process.pid}`);
  const getFunction = name => {
    const found = result.functions.find(fn => fn.name === name);
    assert.ok(found, `Missing function analysis: ${name}`);
    return found;
  };
  const scenariosFor = (fn, condition, outcome) => fn.scenarios.filter(item => item.target.condition === condition && item.target.outcome === outcome);
  const find = (fn, predicate, description) => {
    const scenario = fn.scenarios.find(predicate);
    assert.ok(scenario, `Missing scenario: ${description}`);
    return scenario;
  };
  const execute = (fn, scenario) => fixtureModule[fn.name](...scenario.arguments.map(revive));

  // break / continue: statements after a transfer must not be analyzed on that path.
  const control = getFunction('summarizeUntilStop');
  assert.equal(control.unsupportedBranches.length, 0, JSON.stringify(control.unsupportedBranches));
  const stopTrue = find(control, item => item.target.condition === 'entry.stop' && item.target.outcome === true, 'break branch');
  const skipTrue = find(control, item => item.target.condition === 'entry.skip' && item.target.outcome === true, 'continue branch');
  assert.equal(stopTrue.arguments[0].entries[0].stop, true);
  assert.equal(skipTrue.arguments[0].entries[0].stop, false);
  assert.equal(skipTrue.arguments[0].entries[0].skip, true);
  assert.equal(scenariosFor(control, 'entry.enabled', true).length > 0, true);
  for (const scenario of control.scenarios) assert.doesNotThrow(() => execute(control, scenario));

  const nested = getFunction('summarizeWithNestedContinue');
  const accepted = find(nested, item => item.target.condition === 'item.accepted' && item.target.outcome === true, 'statement after nested continue');
  assert.equal(accepted.arguments[0].items[0].skip, false);
  assert.equal(accepted.arguments[0].items[0].accepted, true);
  for (const scenario of nested.scenarios) assert.doesNotThrow(() => execute(nested, scenario));

  // forEach callback branches.
  const forEach = getFunction('countEnabledWithForEach');
  assert.equal(forEach.unsupportedBranches.length, 0, JSON.stringify(forEach.unsupportedBranches));
  assert.ok(forEach.scenarios.some(item => item.target.loopType === 'array-forEach' && item.target.outcome === 'zero-callbacks'));
  assert.ok(forEach.scenarios.some(item => item.target.loopType === 'array-forEach' && item.target.outcome === 'multiple-callbacks'));
  const enabled = find(forEach, item => item.target.condition === 'item.enabled' && item.target.outcome === true, 'forEach callback true branch');
  assert.equal(enabled.arguments[0].items[0].enabled, true);
  const disabledScore = find(forEach, item => item.target.condition === 'item.score > 5' && item.target.outcome === true, 'forEach callback else-if');
  assert.equal(disabledScore.arguments[0].items[0].enabled, false);
  assert.equal(disabledScore.arguments[0].items[0].score, 6);
  for (const scenario of forEach.scenarios) assert.doesNotThrow(() => execute(forEach, scenario));

  // map callback ternaries.
  const map = getFunction('mapAgeCategory');
  const minor = find(map, item => item.target.kind === 'ternary' && item.target.condition === 'person.age < 18' && item.target.outcome === true, 'map callback ternary true');
  const adult = find(map, item => item.target.kind === 'ternary' && item.target.condition === 'person.age < 18' && item.target.outcome === false, 'map callback ternary false');
  assert.equal(minor.arguments[0].people[0].age, 17);
  assert.equal(adult.arguments[0].people[0].age, 18);
  assert.deepEqual(execute(map, minor), ['minor']);
  assert.deepEqual(execute(map, adult), ['adult']);

  // some/every inline predicates both get true/false callback-result data.
  const some = getFunction('hasAdultWithSome');
  assert.equal(some.unsupportedBranches.length, 0, JSON.stringify(some.unsupportedBranches));
  const someTrue = find(some, item => item.target.kind === 'array-predicate' && item.target.condition === 'person.age >= 18' && item.target.outcome === true, 'some predicate true');
  const someFalse = find(some, item => item.target.kind === 'array-predicate' && item.target.condition === 'person.age >= 18' && item.target.outcome === false, 'some predicate false');
  assert.equal(someTrue.arguments[0].people[0].age, 18);
  assert.equal(someFalse.arguments[0].people[0].age, 17);
  assert.equal(execute(some, someTrue), true);
  assert.equal(execute(some, someFalse), false);

  const someIf = getFunction('hasReadyWithSomeIf');
  const someIfTrue = find(someIf, item => item.target.condition.startsWith('input.items.some') && item.target.outcome === true, 'if some true');
  const someIfFalse = find(someIf, item => item.target.condition.startsWith('input.items.some') && item.target.outcome === false, 'if some false');
  assert.equal(execute(someIf, someIfTrue), true);
  assert.equal(execute(someIf, someIfFalse), false);
  assert.equal(someIfTrue.arguments[0].items[0].ready, true);
  assert.equal(someIfFalse.arguments[0].items[0].ready, false);

  const every = getFunction('allReadyWithEvery');
  assert.equal(every.unsupportedBranches.length, 0, JSON.stringify(every.unsupportedBranches));
  const everyTrue = find(every, item => item.target.kind === 'array-predicate' && item.target.condition === 'item.ready' && item.target.outcome === true, 'every predicate true');
  const everyFalse = find(every, item => item.target.kind === 'array-predicate' && item.target.condition === 'item.ready' && item.target.outcome === false, 'every predicate false');
  assert.equal(everyTrue.arguments[0].items[0].ready, true);
  assert.equal(everyFalse.arguments[0].items[0].ready, false);
  assert.equal(execute(every, everyTrue), true);
  assert.equal(execute(every, everyFalse), false);

  // Callback index 1 gets a separate path context.
  const indexed = getFunction('detectSecondCallbackIndex');
  assert.equal(indexed.unsupportedBranches.length, 0, JSON.stringify(indexed.unsupportedBranches));
  const secondIndex = find(indexed, item => item.target.condition === 'index === 1' && item.target.outcome === true && item.target.iterationIndex === 1, 'callback index 1 branch');
  assert.equal(secondIndex.arguments[0].items.length, 2);
  assert.equal(execute(indexed, secondIndex), true);

  // break inside switch exits only the switch; continue inside switch exits the loop iteration.
  const switchContinue = getFunction('summarizeWithSwitchContinue');
  const afterSwitchTrue = find(switchContinue, item => item.target.condition === 'item.afterSwitch' && item.target.outcome === true, 'post-switch true branch');
  assert.notEqual(afterSwitchTrue.arguments[0].items[0].action, 'continue-loop');
  assert.equal(afterSwitchTrue.arguments[0].items[0].afterSwitch, true);
  const leaveSwitch = switchContinue.scenarios.find(item => item.target.kind === 'switch' && item.target.condition === "'leave-switch'");
  assert.ok(leaveSwitch, 'Expected switch break case scenario');
  const continueCase = switchContinue.scenarios.find(item => item.target.kind === 'switch' && item.target.condition === "'continue-loop'");
  assert.ok(continueCase, 'Expected switch continue case scenario');
  for (const scenario of switchContinue.scenarios) assert.doesNotThrow(() => execute(switchContinue, scenario));

  const someIndex = getFunction('hasSecondActiveItemWithSome');
  assert.equal(someIndex.unsupportedBranches.length, 0, JSON.stringify(someIndex.unsupportedBranches));
  const someSecond = find(someIndex, item => item.target.kind === 'array-predicate' && item.target.condition === 'index === 1 && item.active' && item.target.outcome === true && item.target.iterationIndex === 1, 'some matches at second index');
  assert.equal(someSecond.arguments[0].items.length, 2);
  assert.equal(someSecond.arguments[0].items[0].active, false);
  assert.equal(someSecond.arguments[0].items[1].active, true);
  assert.equal(execute(someIndex, someSecond), true);

  console.log('Control-flow and array-method tests passed: break, continue, nested blocks, switch propagation, forEach, map, some, every, callback indexes and later some() match.');
} finally {
  try { fs.unlinkSync(output); } catch { /* no temp output */ }
}
