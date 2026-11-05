import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'loops.js');
const output = path.join(os.tmpdir(), `branch-scenarios-loops-${process.pid}.json`);

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
  const scenario = (fn, predicate, message) => {
    const found = fn.scenarios.find(predicate);
    assert.ok(found, message);
    return found;
  };
  const execute = (fn, item) => fixtureModule[fn.name](...item.arguments);
  const noUnsupported = fn => assert.equal(fn.unsupportedBranches.length, 0, `${fn.name} has unsupported loop branches: ${JSON.stringify(fn.unsupportedBranches)}`);

  const passengers = getFunction('summarizePassengers');
  noUnsupported(passengers);
  const passengerLoopOutcomes = passengers.scenarios
    .filter(item => item.target.loopType === 'for-of')
    .map(item => item.target.outcome);
  assert.deepEqual(passengerLoopOutcomes, ['zero-iterations', 'one-iteration', 'multiple-iterations']);
  const noPassengers = scenario(passengers, item => item.target.outcome === 'zero-iterations', 'Expected empty for...of input');
  const multiplePassengers = scenario(passengers, item => item.target.outcome === 'multiple-iterations', 'Expected multiple-iteration input');
  assert.deepEqual(noPassengers.arguments[0].passengers, []);
  assert.equal(multiplePassengers.arguments[0].passengers.length, 2);
  assert.doesNotThrow(() => execute(passengers, noPassengers));
  assert.deepEqual(execute(passengers, multiplePassengers), { minors: 2, active: 0 });
  const minorBranch = scenario(passengers, item => item.target.condition === 'passenger.age < 18' && item.target.outcome === true, 'Expected body condition true for first loop element');
  assert.equal(minorBranch.arguments[0].passengers[0].age, 17);
  assert.doesNotThrow(() => execute(passengers, minorBranch));

  const segments = getFunction('sumPositiveSegments');
  noUnsupported(segments);
  const enterFor = scenario(segments, item => item.target.loopType === 'for' && item.target.phase === 'initial-condition', 'Expected classic for loop entry scenario');
  const skipFor = scenario(segments, item => item.target.loopType === 'for' && item.target.phase === 'zero-iterations', 'Expected classic for zero-iteration scenario');
  assert.equal(enterFor.arguments[0].segments.length, 1);
  assert.deepEqual(skipFor.arguments[0].segments, []);
  assert.doesNotThrow(() => execute(segments, enterFor));
  assert.doesNotThrow(() => execute(segments, skipFor));
  const positiveSegment = scenario(segments, item => item.target.condition === 'input.segments[index].distance > 0' && item.target.outcome === true, 'Expected indexed loop element positive branch');
  assert.equal(positiveSegment.arguments[0].segments[0].distance, 1);
  assert.doesNotThrow(() => execute(segments, positiveSegment));

  const records = getFunction('countActiveRecords');
  noUnsupported(records);
  const emptyRecords = scenario(records, item => item.target.loopType === 'for-in' && item.target.outcome === 'zero-iterations', 'Expected empty for...in input');
  const oneRecord = scenario(records, item => item.target.loopType === 'for-in' && item.target.outcome === 'one-iteration', 'Expected non-empty for...in input');
  assert.deepEqual(emptyRecords.arguments[0].records, {});
  assert.equal(Object.keys(oneRecord.arguments[0].records).length, 1);
  const activeRecord = scenario(records, item => item.target.condition === 'input.records[key].isActive' && item.target.outcome === true, 'Expected for...in body true branch');
  assert.equal(Object.values(activeRecord.arguments[0].records)[0].isActive, true);
  assert.doesNotThrow(() => execute(records, activeRecord));

  const whileLoop = getFunction('countUntilLimit');
  noUnsupported(whileLoop);
  const whileTrue = scenario(whileLoop, item => item.target.outcome === true, 'Expected while true scenario');
  const whileFalse = scenario(whileLoop, item => item.target.outcome === false, 'Expected while false scenario');
  assert.deepEqual(whileTrue.arguments[0], { count: 0, limit: 1 });
  assert.deepEqual(whileFalse.arguments[0], { count: 1, limit: 0 });
  assert.doesNotThrow(() => execute(whileLoop, whileTrue));
  assert.doesNotThrow(() => execute(whileLoop, whileFalse));

  const doWhile = getFunction('doWhileAtLeastOnce');
  noUnsupported(doWhile);
  const doWhileTrue = scenario(doWhile, item => item.target.outcome === true, 'Expected do...while true scenario');
  const doWhileFalse = scenario(doWhile, item => item.target.outcome === false, 'Expected do...while false scenario');
  assert.deepEqual(doWhileTrue.arguments[0], { limit: 2 });
  assert.deepEqual(doWhileFalse.arguments[0], { limit: 1 });
  assert.doesNotThrow(() => execute(doWhile, doWhileTrue));
  assert.doesNotThrow(() => execute(doWhile, doWhileFalse));

  const fixed = getFunction('fixedIterations');
  noUnsupported(fixed);
  const fixedTrue = scenario(fixed, item => item.target.loopType === 'for' && item.target.outcome === true, 'Expected constant-bound for true outcome');
  const fixedExit = scenario(fixed, item => item.target.loopType === 'for' && item.target.outcome === false && item.target.phase === 'exit-after-iterations', 'Expected for false outcome after loop iterations');
  assert.deepEqual(fixedTrue.arguments, []);
  assert.deepEqual(fixedExit.arguments, []);
  assert.equal(execute(fixed, fixedTrue), 3);
  assert.equal(execute(fixed, fixedExit), 3);


  const groups = getFunction('summarizeGroups');
  noUnsupported(groups);
  const nestedMinor = scenario(groups, item => item.target.condition === 'passenger.age < 18' && item.target.outcome === true, 'Expected nested for...of body branch');
  assert.equal(nestedMinor.arguments[0].groups[0].passengers[0].age, 17);
  assert.equal(execute(groups, nestedMinor), 1);

  const localCounter = getFunction('countToLimit');
  noUnsupported(localCounter);
  const localCounterTrue = scenario(localCounter, item => item.target.outcome === true, 'Expected while loop with local counter true scenario');
  const localCounterFalse = scenario(localCounter, item => item.target.outcome === false, 'Expected while loop with local counter false scenario');
  assert.deepEqual(localCounterTrue.arguments[0], { limit: 1 });
  assert.deepEqual(localCounterFalse.arguments[0], { limit: 0 });
  assert.equal(execute(localCounter, localCounterTrue), 1);
  assert.equal(execute(localCounter, localCounterFalse), 0);


  const fixedWhile = getFunction('fixedWhile');
  noUnsupported(fixedWhile);
  const fixedWhileTrue = scenario(fixedWhile, item => item.target.outcome === true, 'Expected fixed while true outcome');
  const fixedWhileExit = scenario(fixedWhile, item => item.target.outcome === false && item.target.phase === 'exit-after-iterations', 'Expected fixed while exit outcome');
  assert.equal(execute(fixedWhile, fixedWhileTrue), 3);
  assert.equal(execute(fixedWhile, fixedWhileExit), 3);

  const fixedDoWhile = getFunction('fixedDoWhile');
  noUnsupported(fixedDoWhile);
  const fixedDoWhileTrue = scenario(fixedDoWhile, item => item.target.outcome === true, 'Expected fixed do...while true outcome');
  const fixedDoWhileExit = scenario(fixedDoWhile, item => item.target.outcome === false && item.target.phase === 'exit-after-iterations', 'Expected fixed do...while exit outcome');
  assert.equal(execute(fixedDoWhile, fixedDoWhileTrue), 3);
  assert.equal(execute(fixedDoWhile, fixedDoWhileExit), 3);


  const secondItem = getFunction('findSecondActiveItem');
  noUnsupported(secondItem);
  const secondItemActive = scenario(secondItem, item => item.target.condition === 'input.items[index].isActive' && item.target.outcome === true, 'Expected body branch using a non-zero loop index');
  assert.equal(secondItemActive.arguments[0].items.length, 2);
  assert.equal(secondItemActive.arguments[0].items[1].isActive, true);
  assert.equal(execute(secondItem, secondItemActive), 1);

  for (const fn of result.functions) {
    assert.ok(fn.summary.loopsAnalyzed >= 1, `${fn.name} should report a loop`);
    assert.ok(fn.summary.loopScenariosGenerated >= 0);
  }

  console.log('Loop tests passed: for, for...of, for...in, while, do...while, loop-local aliases and loop-body branches.');
} finally {
  try { fs.unlinkSync(output); } catch { /* No output to clean up. */ }
}
