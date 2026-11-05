import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'passenger-no-jsdoc.js');
const output = path.join(os.tmpdir(), `branch-scenarios-${process.pid}.json`);

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--out', output], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);

  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const fixtureModule = await import(pathToFileURL(fixture).href);
  const revive = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
    return value;
  };
  const assertTargets = (functionResult, parameterNames) => {
    for (const scenario of functionResult.scenarios) {
      const args = scenario.arguments.map(revive);
      const conditionResult = new Function(...parameterNames, `return Boolean(${scenario.target.condition});`)(...args);
      assert.equal(conditionResult, scenario.target.outcome, `Scenario ${scenario.id} does not satisfy its recorded branch target`);
      assert.doesNotThrow(() => fixtureModule[functionResult.name](...args), `Scenario ${scenario.id} throws when executing ${functionResult.name}`);
    }
  };
  const category = result.functions.find(item => item.name === 'getPassengerCategory');
  const flight = result.functions.find(item => item.name === 'getFlightLabel');
  const readiness = result.functions.find(item => item.name === 'getReadiness');
  const codeLength = result.functions.find(item => item.name === 'getCodeLength');
  const passengerAge = result.functions.find(item => item.name === 'getPassengerAgeStatus');
  const simple = result.functions.find(item => item.name === 'getSimpleCategory');
  assert.ok(category && flight && readiness && codeLength && passengerAge && simple, 'Expected all fixture functions to be analyzed');

  const categoryTypes = Object.fromEntries(category.inferredProperties.map(item => [item.path, item]));
  assert.equal(categoryTypes['passenger.age']?.inferredType, 'number');
  assert.equal(categoryTypes['passenger.country']?.inferredType, 'string');
  assert.equal(categoryTypes['passenger.isPremium']?.inferredType, 'boolean');
  assert.equal(categoryTypes['passenger.isPremium']?.confidence, 'heuristic');
  assertTargets(category, ['passenger']);
  const premiumRootScenario = simple.scenarios.find(item => item.target.condition === 'isPremium' && item.target.outcome === true);
  const notPremiumRootScenario = simple.scenarios.find(item => item.target.condition === 'isPremium' && item.target.outcome === false);
  assert.equal(premiumRootScenario.arguments[1], true);
  assert.equal(notPremiumRootScenario.arguments[1], false);
  assert.equal(typeof simple.scenarios.find(item => item.target.condition === 'age < 18' && item.target.outcome === true).arguments[0], 'number');
  assertTargets(simple, ['age', 'isPremium']);

  const premiumScenario = category.scenarios.find(item =>
    item.target.condition === "passenger.isPremium && passenger.country === 'NL'" && item.target.outcome === true
  );
  assert.ok(premiumScenario, 'Expected true scenario for premium NL condition');
  assert.deepEqual(premiumScenario.arguments[0], {
    age: 18,
    isPremium: true,
    country: 'NL',
  });

  const flightTrue = flight.scenarios.find(item =>
    item.target.condition === 'flight.profile.isActive && flight.segments.length > 1' && item.target.outcome === true
  );
  assert.ok(flightTrue, 'Expected true scenario for nested object + array condition');
  assert.equal(flightTrue.arguments[0].profile.isActive, true);
  assert.equal(Array.isArray(flightTrue.arguments[0].segments), true);
  assert.ok(flightTrue.arguments[0].segments.length > 1);
  assertTargets(flight, ['flight']);

  const codeType = codeLength.inferredProperties.find(item => item.path === 'input.code');
  assert.equal(codeType?.inferredType, 'string');
  const codeLengthScenario = codeLength.scenarios.find(item => item.target.outcome === true);
  assert.equal(typeof codeLengthScenario.arguments[0].code, 'string');
  assert.equal(codeLengthScenario.arguments[0].code.length, 2);
  assertTargets(codeLength, ['input']);

  const arrayItem = passengerAge.scenarios.find(item => item.target.outcome === true);
  assert.equal(Array.isArray(arrayItem.arguments[0].passengers), true);
  assert.equal(arrayItem.arguments[0].passengers[0].age, 17);
  assertTargets(passengerAge, ['input']);
  assertTargets(readiness, ['input']);

  const unknownOwner = readiness.inferredProperties.find(item => item.path === 'input.metadata.owner');
  assert.equal(unknownOwner?.inferredType, 'unknown');
  assert.equal(unknownOwner?.confidence, 'low');
  assert.match(unknownOwner?.evidence.join(' ') ?? '', /no primitive type constraint/i);

  console.log('Smoke tests passed: JS without JSDoc, boolean inference, nested objects, arrays and unknown-property reporting.');
} finally {
  try { fs.unlinkSync(output); } catch { /* No output to clean up. */ }
}
