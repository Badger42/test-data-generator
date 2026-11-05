import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'array-method-chains.js');
const output = path.join(os.tmpdir(), `branch-scenarios-chains-${process.pid}.json`);
try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--out', output], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const mod = await import(`${pathToFileURL(fixture).href}?test=${process.pid}`);
  const get = name => report.functions.find(fn => fn.name === name);
  const target = (fn, conditionPart, outcome) => fn.scenarios.find(s => s.target.condition.includes(conditionPart) && s.target.outcome === outcome);
  const scenario = (fn, predicate, description) => { const found = fn.scenarios.find(predicate); assert.ok(found, `Missing scenario: ${description}`); return found; }
  const execute = (fn, scenario) => mod[fn.name](...scenario.arguments);

  const filtered = get('filteredMappedSome');
  assert.ok(filtered, 'filteredMappedSome missing');
  assert.ok(target(filtered, 'price > 10', true), 'mapped scalar predicate true missing');
  assert.ok(target(filtered, 'price > 10', false), 'mapped scalar predicate false missing');
  for (const scenario of filtered.scenarios) assert.doesNotThrow(() => execute(filtered, scenario), scenario.id);
  const trueScenario = target(filtered, 'price > 10', true);
  assert.equal(execute(filtered, trueScenario), true);
  assert.equal(trueScenario.arguments[0].items[0].active, true, 'upstream filter must be satisfied');
  assert.ok(trueScenario.arguments[0].items[0].price > 10, 'map projection must map to source price');
  const multiSome = filtered.scenarios.find(item => item.target.kind === 'loop' && item.target.outcome === 'multiple-callbacks');
  assert.ok(multiSome.arguments[0].items.every(item => item.active === true), 'each source item must pass the upstream filter');

  const mappedObject = get('mappedObjectThenSome');
  assert.ok(target(mappedObject, 'row.amount > 10', true), 'object projection amount true missing');
  assert.ok(target(mappedObject, 'row.enabled', true), 'object projection enabled true missing');
  for (const scenario of mappedObject.scenarios) assert.doesNotThrow(() => execute(mappedObject, scenario), scenario.id);

  const mappedFilter = get('mappedFilterThenFind');
  assert.ok(mappedFilter, 'mappedFilterThenFind missing');
  for (const scenario of mappedFilter.scenarios) assert.doesNotThrow(() => execute(mappedFilter, scenario), scenario.id);
  const multiFind = mappedFilter.scenarios.find(item => item.target.kind === 'loop' && item.target.outcome === 'multiple-callbacks');
  assert.ok(multiFind.arguments[0].items.every(item => item.profile.active === true), 'each source item must pass the chained filter');

  const filterMapCount = get('filterMapFilterCount');
  assert.ok(filterMapCount, 'filterMapFilterCount missing');
  for (const scenario of filterMapCount.scenarios) assert.doesNotThrow(() => execute(filterMapCount, scenario), scenario.id);

  const flatMapped = get('flatMappedPassengerSome');
  assert.ok(flatMapped, 'flatMappedPassengerSome missing');
  assert.ok(target(flatMapped, 'passenger.age >= 18', true), 'flatMap downstream predicate true missing');
  assert.ok(target(flatMapped, 'passenger.age >= 18', false), 'flatMap downstream predicate false missing');
  const flatMapTrue = target(flatMapped, 'passenger.age >= 18', true);
  assert.ok(flatMapTrue.arguments[0].groups[0].passengers[0].age >= 18);
  for (const scenario of flatMapped.scenarios) assert.doesNotThrow(() => execute(flatMapped, scenario), scenario.id);

  const reduceState = get('reduceWithInterIterationState');
  const reduceStateTrue = scenario(reduceState,
    item => item.target.condition === 'total > 10' && item.target.outcome === true && item.target.iterationIndex === 1,
    'reduce accumulator true after first iteration');
  assert.equal(reduceStateTrue.arguments[0].values[0], 11);
  assert.equal(execute(reduceState, reduceStateTrue), 10);
  const reduceStateFalse = scenario(reduceState,
    item => item.target.condition === 'total > 10' && item.target.outcome === false && item.target.iterationIndex === 1,
    'reduce accumulator false after first iteration');
  assert.notEqual(reduceStateFalse.arguments[0].values[0], 11);
  assert.ok(execute(reduceState, reduceStateFalse) >= 0);
  assert.equal(reduceState.unsupportedBranches.length, 0, JSON.stringify(reduceState.unsupportedBranches));

  const reduceNoSeed = get('reduceWithoutInitialInterIterationState');
  const reduceNoSeedTrue = scenario(reduceNoSeed,
    item => item.target.condition === 'total > 10' && item.target.outcome === true && item.target.iterationIndex === 2,
    'reduce accumulator true after prior unseeded reducer call');
  const reduceNoSeedValues = reduceNoSeedTrue.arguments[0].values;
  assert.ok(reduceNoSeedValues.length >= 3);
  assert.equal(execute(reduceNoSeed, reduceNoSeedTrue), 10);
  const reduceNoSeedFalse = scenario(reduceNoSeed,
    item => item.target.condition === 'total > 10' && item.target.outcome === false && item.target.iterationIndex === 2,
    'reduce accumulator false after prior unseeded reducer call');
  assert.notEqual(execute(reduceNoSeed, reduceNoSeedFalse), 10);
  assert.equal(reduceNoSeed.unsupportedBranches.length, 0, JSON.stringify(reduceNoSeed.unsupportedBranches));

  const reduceObject = get('reduceObjectAccumulatorAcrossIterations');
  const reduceObjectTrue = scenario(reduceObject,
    item => item.target.condition === 'accumulator.total > 10' && item.target.outcome === true && item.target.iterationIndex === 1,
    'object accumulator true after first iteration');
  assert.equal(reduceObjectTrue.arguments[0].items[0].amount, 11);
  assert.equal(execute(reduceObject, reduceObjectTrue).total, 10);
  const reduceObjectFalse = scenario(reduceObject,
    item => item.target.condition === 'accumulator.total > 10' && item.target.outcome === false && item.target.iterationIndex === 1,
    'object accumulator false after first iteration');
  assert.notEqual(execute(reduceObject, reduceObjectFalse).total, 10);
  assert.equal(reduceObject.unsupportedBranches.length, 0, JSON.stringify(reduceObject.unsupportedBranches));

  const reduceTwoSteps = get('reduceAfterTwoPriorIterations');
  const reduceTwoStepsTrue = scenario(reduceTwoSteps,
    item => item.target.condition === 'total >= 10' && item.target.outcome === true && item.target.iterationIndex === 2 && item.arguments[0].values[0] === 6 && item.arguments[0].values[1] === 6,
    'reduce accumulator true after two prior iterations');
  assert.ok(reduceTwoStepsTrue.arguments[0].values.length >= 3);
  assert.equal(execute(reduceTwoSteps, reduceTwoStepsTrue), 11);
  const reduceTwoStepsFalse = scenario(reduceTwoSteps,
    item => item.target.condition === 'total >= 10' && item.target.outcome === false && item.target.iterationIndex === 2,
    'reduce accumulator false after two prior iterations');
  assert.ok(execute(reduceTwoSteps, reduceTwoStepsFalse) < 10);
  assert.equal(reduceTwoSteps.unsupportedBranches.length, 0, JSON.stringify(reduceTwoSteps.unsupportedBranches));

  const reduceTwoStepsNoInitial = get('reduceWithoutInitialAfterTwoPriorIterations');
  const reduceTwoStepsNoInitialTrue = scenario(reduceTwoStepsNoInitial,
    item => item.target.condition === 'total >= 10' && item.target.outcome === true && item.target.iterationIndex === 3 && item.arguments[0].values[1] === 6 && item.arguments[0].values[2] === 6,
    'unseeded reduce accumulator true after two prior iterations');
  assert.ok(reduceTwoStepsNoInitialTrue.arguments[0].values.length >= 4);
  assert.equal(execute(reduceTwoStepsNoInitial, reduceTwoStepsNoInitialTrue), 11);
  const reduceTwoStepsNoInitialFalse = scenario(reduceTwoStepsNoInitial,
    item => item.target.condition === 'total >= 10' && item.target.outcome === false && item.target.iterationIndex === 3,
    'unseeded reduce accumulator false after two prior iterations');
  assert.ok(execute(reduceTwoStepsNoInitial, reduceTwoStepsNoInitialFalse) < 10);
  assert.equal(reduceTwoStepsNoInitial.unsupportedBranches.length, 0, JSON.stringify(reduceTwoStepsNoInitial.unsupportedBranches));

  const reduceObjectTwoSteps = get('reduceObjectAccumulatorAfterTwoIterations');
  const reduceObjectTwoStepsTrue = scenario(reduceObjectTwoSteps,
    item => item.target.condition === 'accumulator.total >= 10' && item.target.outcome === true && item.target.iterationIndex === 2 && item.arguments[0].items[0].amount === 6 && item.arguments[0].items[1].amount === 6,
    'object accumulator true after two prior iterations');
  assert.equal(execute(reduceObjectTwoSteps, reduceObjectTwoStepsTrue).total, 11);
  const reduceObjectTwoStepsFalse = scenario(reduceObjectTwoSteps,
    item => item.target.condition === 'accumulator.total >= 10' && item.target.outcome === false && item.target.iterationIndex === 2,
    'object accumulator false after two prior iterations');
  assert.ok(execute(reduceObjectTwoSteps, reduceObjectTwoStepsFalse).total < 10);
  assert.equal(reduceObjectTwoSteps.unsupportedBranches.length, 0, JSON.stringify(reduceObjectTwoSteps.unsupportedBranches));

  const reduceMutable = get('reduceMutatingObjectAfterTwoIterations');
  const reduceMutableTrue = scenario(reduceMutable,
    item => item.target.condition === 'accumulator.total >= 10' && item.target.outcome === true && item.target.iterationIndex === 2 && item.arguments[0].items[0].amount === 6 && item.arguments[0].items[1].amount === 6,
    'mutating object accumulator true after two prior iterations');
  assert.equal(execute(reduceMutable, reduceMutableTrue).total, 13);
  const reduceMutableFalse = scenario(reduceMutable,
    item => item.target.condition === 'accumulator.total >= 10' && item.target.outcome === false && item.target.iterationIndex === 2,
    'mutating object accumulator false after two prior iterations');
  assert.ok(execute(reduceMutable, reduceMutableFalse).total < 10);
  assert.equal(reduceMutable.unsupportedBranches.length, 0, JSON.stringify(reduceMutable.unsupportedBranches));

  console.log('Array chain/reduce-state tests passed: chained filter/map/find/some predicates and up-to-two prior scalar/object reduce transitions.');
} finally {
  try { fs.unlinkSync(output); } catch { /* cleanup */ }
}
