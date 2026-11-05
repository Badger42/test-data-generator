import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'mcdc-callbacks-advanced.js');
const output = path.join(os.tmpdir(), `branch-scenarios-mcdc-callbacks-advanced-${process.pid}.json`);

const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

const readPath = (root, value) => value.split('.').slice(1).reduce((node, key) => node?.[key], root);
const evaluate = (expression, parameters, item, index, root) => {
  const args = parameters.map((name, position) => position === 0 ? item : position === 1 ? index : undefined);
  return new Function(...parameters, 'input', `return Boolean(${expression});`)(...args, root);
};

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
    'indexSensitive', 'indexAndProperty', 'callbackLocalAliases',
    'callbackLocalAliasChain', 'callbackLocalAliasesInIf', 'callbackLocalAliasesWithNestedIf',
    'conditionalReturnMustRemainControlFlow',
  ];
  for (const name of expected) assert.ok(functions.has(name), `Missing function ${name}`);

  let callbackDecisions = 0;
  let verifiedPairs = 0;
  for (const name of expected) {
    const fnResult = functions.get(name);
    const decisions = fnResult.mcdc.decisions.filter(item => item.callbackContext);
    assert.ok(decisions.length > 0, `${name}: expected callback MC/DC decisions`);
    for (const decision of decisions) {
      callbackDecisions += 1;
      const params = decision.callbackContext.parameters;
      const collectionPath = decision.callbackContext.collection;
      for (const condition of decision.conditions) {
        for (const pair of condition.independencePairs) {
          const falseScenario = pair.scenarios.conditionFalse;
          const trueScenario = pair.scenarios.conditionTrue;
          const falseArgs = falseScenario.arguments.map(revive);
          const trueArgs = trueScenario.arguments.map(revive);
          const falseInput = falseArgs[0];
          const trueInput = trueArgs[0];
          const falseIndex = falseScenario.callbackContext.iterationIndex ?? 0;
          const trueIndex = trueScenario.callbackContext.iterationIndex ?? 0;
          const falseCollection = readPath(falseInput, collectionPath);
          const trueCollection = readPath(trueInput, collectionPath);
          assert.ok(Array.isArray(falseCollection) && falseCollection[falseIndex], `${pair.pairId}: false item missing at ${falseIndex}`);
          assert.ok(Array.isArray(trueCollection) && trueCollection[trueIndex], `${pair.pairId}: true item missing at ${trueIndex}`);
          const falseItem = falseCollection[falseIndex];
          const trueItem = trueCollection[trueIndex];
          assert.equal(evaluate(decision.expression, params, falseItem, falseIndex, falseInput), falseScenario.decisionOutcome, `${pair.pairId}: false decision mismatch`);
          assert.equal(evaluate(decision.expression, params, trueItem, trueIndex, trueInput), trueScenario.decisionOutcome, `${pair.pairId}: true decision mismatch`);
          assert.notEqual(falseScenario.decisionOutcome, trueScenario.decisionOutcome, `${pair.pairId}: decision must change`);
          for (const other of decision.conditions) {
            const falseValue = evaluate(other.expression, params, falseItem, falseIndex, falseInput);
            const trueValue = evaluate(other.expression, params, trueItem, trueIndex, trueInput);
            if (other.id === condition.id) assert.notEqual(falseValue, trueValue, `${pair.pairId}: target ${other.id} must change`);
            else assert.equal(falseValue, trueValue, `${pair.pairId}: non-target ${other.id} must remain fixed`);
          }
          assert.doesNotThrow(() => module[name](...falseArgs), `${pair.pairId}: false runtime call`);
          assert.doesNotThrow(() => module[name](...trueArgs), `${pair.pairId}: true runtime call`);
          verifiedPairs += 1;
        }
      }
    }
  }

  const indexDecision = functions.get('indexSensitive').mcdc.decisions.find(item => item.callbackContext);
  const indexCondition = indexDecision.conditions.find(item => item.expression.includes('index'));
  assert.ok(indexCondition, 'indexSensitive: index atom missing');
  const variedPair = indexCondition.independencePairs.find(pair => pair.variedCallbackIndex);
  assert.ok(variedPair, 'indexSensitive: expected an independence pair using different callback indexes');
  assert.deepEqual(variedPair.variedCallbackIndex, { conditionFalse: 0, conditionTrue: 1 });

  const localDecision = functions.get('callbackLocalAliases').mcdc.decisions.find(item => item.callbackContext);
  assert.equal(localDecision.conditions.length, 3, 'local const aliases should be expanded into three atomic conditions');
  assert.ok(localDecision.expression.includes('passenger.age >= 18'));
  assert.ok(localDecision.expression.includes('passenger.isActive'));
  assert.ok(localDecision.expression.includes('passenger.country === input.country'));
  assert.ok(localDecision.conditions.every(item => item.status === 'covered'));
  assert.ok(localDecision.sourceExpression.includes('isEligible'), 'original local-variable expression should be preserved');
  assert.ok(!localDecision.expression.includes('isEligible'), 'decision expression should contain expanded const initializers');

  const localIfDecision = functions.get('callbackLocalAliasesInIf').mcdc.decisions.find(item => item.callbackContext);
  assert.ok(localIfDecision, 'expected MC/DC for if condition that references callback-local const aliases');
  assert.equal(localIfDecision.conditions.length, 2);
  assert.ok(localIfDecision.conditions.every(item => item.status === 'covered'));

  const conditionalReturnDecisions = functions.get('conditionalReturnMustRemainControlFlow').mcdc.decisions.filter(item => item.callbackContext);
  assert.ok(conditionalReturnDecisions.some(item => item.kind === 'if'), 'conditional return must keep its if decision');
  assert.ok(!conditionalReturnDecisions.some(item => item.kind === 'array-predicate-some' && item.expression === 'item.ready'), 'conditional return must not be flattened to a standalone predicate');

  assert.ok(callbackDecisions >= 7, `Expected at least 7 callback decisions, got ${callbackDecisions}`);
  assert.ok(verifiedPairs >= 12, `Expected at least 12 verified callback pairs, got ${verifiedPairs}`);
  console.log(`Advanced callback MC/DC tests passed: ${callbackDecisions} callback decision(s), ${verifiedPairs} verified pair(s), including index-varying pairs and local const expansion.`);
} finally {
  fs.rmSync(output, { force: true });
}
