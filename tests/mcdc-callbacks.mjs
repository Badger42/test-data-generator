import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'mcdc-callbacks.js');
const output = path.join(os.tmpdir(), `branch-scenarios-mcdc-callbacks-${process.pid}.json`);

const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

const readPath = (root, value) => value.split('.').slice(1).reduce((node, key) => node?.[key], root);

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--mcdc', '--out', output], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const module = await import(pathToFileURL(fixture).href);
  const functions = new Map(result.functions.map(fn => [fn.name, fn]));
  const expected = [
    'someAdults', 'everyAllowed', 'filterEligible', 'findEligible',
    'findIndexEligible', 'blockReturnPredicate', 'blockIfPredicate',
    'chainedPredicate', 'nestedPredicate',
  ];
  for (const name of expected) assert.ok(functions.has(name), `Missing function ${name}`);

  let verifiedPairs = 0;
  let callbackDecisions = 0;
  for (const fn of result.functions) {
    for (const decision of fn.mcdc.decisions) {
      if (!decision.callbackContext) continue;
      callbackDecisions += 1;
      const callbackContext = decision.callbackContext;
      assert.ok(callbackContext.method, `${decision.decisionId}: method metadata missing`);
      assert.ok(callbackContext.parameters?.length, `${decision.decisionId}: callback parameter metadata missing`);
      const parameterName = callbackContext.parameters[0];
      for (const condition of decision.conditions) {
        for (const pair of condition.independencePairs) {
          const falseScenario = pair.scenarios.conditionFalse;
          const trueScenario = pair.scenarios.conditionTrue;
          const falseArgs = falseScenario.arguments.map(revive);
          const trueArgs = trueScenario.arguments.map(revive);
          const falseInput = falseArgs[0];
          const trueInput = trueArgs[0];
          const falseCollection = readPath(falseInput, callbackContext.collection);
          const trueCollection = readPath(trueInput, callbackContext.collection);
          const index = callbackContext.iterationIndex ?? 0;
          assert.ok(Array.isArray(falseCollection) && falseCollection[index], `${pair.pairId}: false callback item missing`);
          assert.ok(Array.isArray(trueCollection) && trueCollection[index], `${pair.pairId}: true callback item missing`);
          const evaluate = (expression, item, root) => new Function(parameterName, 'input', `return Boolean(${expression});`)(item, root);
          assert.equal(evaluate(decision.expression, falseCollection[index], falseInput), falseScenario.decisionOutcome, `${pair.pairId}: false callback expression mismatch`);
          assert.equal(evaluate(decision.expression, trueCollection[index], trueInput), trueScenario.decisionOutcome, `${pair.pairId}: true callback expression mismatch`);
          assert.notEqual(falseScenario.decisionOutcome, trueScenario.decisionOutcome, `${pair.pairId}: callback decision must change`);
          for (const other of decision.conditions) {
            const otherValue = (expression, item, root) => new Function(parameterName, 'input', `return Boolean(${expression});`)(item, root);
            const falseValue = otherValue(other.expression, falseCollection[index], falseInput);
            const trueValue = otherValue(other.expression, trueCollection[index], trueInput);
            if (other.id === condition.id) assert.notEqual(falseValue, trueValue, `${pair.pairId}: target condition must change`);
            else assert.equal(falseValue, trueValue, `${pair.pairId}: non-target ${other.id} must remain fixed`);
          }
          assert.doesNotThrow(() => module[fn.name](...falseArgs), `${pair.pairId}: false runtime call`);
          assert.doesNotThrow(() => module[fn.name](...trueArgs), `${pair.pairId}: true runtime call`);
          verifiedPairs += 1;
        }
      }
    }
  }

  for (const name of expected) {
    const callbackDecisionsForFn = functions.get(name).mcdc.decisions.filter(item => item.callbackContext);
    assert.ok(callbackDecisionsForFn.length > 0, `${name}: expected callback MC/DC decision`);
    if (name !== 'nestedPredicate') assert.ok(callbackDecisionsForFn.some(item => item.conditions.length >= 2), `${name}: expected compound predicate`);
  }
  assert.ok(callbackDecisions >= 9, `Expected at least 9 callback decisions, got ${callbackDecisions}`);
  assert.ok(verifiedPairs >= 18, `Expected at least 18 verified callback pairs, got ${verifiedPairs}`);

  const someDecision = functions.get('someAdults').mcdc.decisions.find(item => item.callbackContext);
  assert.equal(someDecision.callbackContext.method, 'some');
  assert.ok(someDecision.conditions.every(condition => condition.status === 'covered'));

  const chainedDecision = functions.get('chainedPredicate').mcdc.decisions.find(item => item.callbackContext?.method === 'some');
  assert.ok(chainedDecision, 'Expected MC/DC for terminal some() in chained pipeline');
  const nestedDecision = functions.get('nestedPredicate').mcdc.decisions.find(item => item.callbackContext?.method === 'every');
  assert.ok(nestedDecision, 'Expected MC/DC for nested every() callback');
  assert.equal(nestedDecision.conditions.length, 2, 'Nested every() predicate should expose both atomic conditions');
  assert.ok(nestedDecision.conditions.every(condition => condition.status === 'covered'));

  console.log(`MC/DC callback tests passed: ${callbackDecisions} callback decision(s), ${verifiedPairs} independently validated pair(s).`);
} finally {
  fs.rmSync(output, { force: true });
}
