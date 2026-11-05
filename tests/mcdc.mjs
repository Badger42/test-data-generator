import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'mcdc.js');
const output = path.join(os.tmpdir(), `branch-scenarios-mcdc-${process.pid}.json`);
const branchOnlyOutput = path.join(os.tmpdir(), `branch-scenarios-branch-only-${process.pid}.json`);

const revive = value => {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  return value;
};

try {
  const run = spawnSync(process.execPath, [cli, fixture, '--all', '--mcdc', '--out', output], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `CLI failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /MC\/DC:/);

  const branchOnlyRun = spawnSync(process.execPath, [cli, fixture, '--all', '--out', branchOnlyOutput], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(branchOnlyRun.status, 0, `Branch-only CLI failed:\n${branchOnlyRun.stdout}\n${branchOnlyRun.stderr}`);
  const branchOnlyResult = JSON.parse(fs.readFileSync(branchOnlyOutput, 'utf8'));
  assert.ok(branchOnlyResult.functions.every(item => !Object.hasOwn(item, 'mcdc')), 'MC/DC must remain opt-in');

  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const module = await import(pathToFileURL(fixture).href);
  const functions = new Map(result.functions.map(item => [item.name, item]));
  const expected = ['canBoard', 'canAccess', 'canEnter', 'canTravel', 'correlatedConditions', 'ternaryDecision', 'whileDecision', 'forDecision'];
  for (const name of expected) assert.ok(functions.has(name), `Missing analyzed function ${name}`);

  const evaluate = (expression, input) => new Function('input', `return Boolean(${expression});`)(input);
  let verifiedPairs = 0;
  for (const fn of result.functions) {
    assert.ok(fn.mcdc, `${fn.name} should contain MC/DC report`);
    for (const decision of fn.mcdc.decisions) {
      for (const condition of decision.conditions) {
        for (const pair of condition.independencePairs) {
          const falseCase = pair.scenarios.conditionFalse;
          const trueCase = pair.scenarios.conditionTrue;
          const falseInput = revive(falseCase.arguments[0]);
          const trueInput = revive(trueCase.arguments[0]);
          assert.notEqual(evaluate(decision.expression, falseInput), evaluate(decision.expression, trueInput), `${pair.pairId}: decision must change`);

          for (const other of decision.conditions) {
            const falseValue = evaluate(other.expression, falseInput);
            const trueValue = evaluate(other.expression, trueInput);
            if (other.id === condition.id) assert.notEqual(falseValue, trueValue, `${pair.pairId}: target condition must change`);
            else assert.equal(falseValue, trueValue, `${pair.pairId}: non-target ${other.id} must remain fixed`);
          }
          assert.doesNotThrow(() => module[fn.name](...falseCase.arguments.map(revive)), `${pair.pairId}: false-case runtime execution`);
          assert.doesNotThrow(() => module[fn.name](...trueCase.arguments.map(revive)), `${pair.pairId}: true-case runtime execution`);
          verifiedPairs += 1;
        }
      }
    }
  }

  const andDecision = functions.get('canBoard').mcdc.decisions[0];
  assert.equal(andDecision.conditions.length, 2);
  assert.ok(andDecision.conditions.every(item => item.independencePairs.length === 1));

  const nestedDecision = functions.get('canAccess').mcdc.decisions[0];
  assert.equal(nestedDecision.conditions.length, 3);
  assert.ok(nestedDecision.conditions.every(item => item.independencePairs.length === 1));

  const negatedDecision = functions.get('canEnter').mcdc.decisions[0];
  assert.equal(negatedDecision.conditions.length, 3);
  assert.ok(negatedDecision.conditions.every(item => item.independencePairs.length === 1));

  const numericDecision = functions.get('canTravel').mcdc.decisions[0];
  assert.ok(numericDecision.conditions.every(item => item.independencePairs.length === 1));

  const correlated = functions.get('correlatedConditions').mcdc.decisions[0];
  assert.equal(correlated.conditions.filter(item => item.status === 'covered').length, 1);
  assert.equal(correlated.conditions.filter(item => item.status === 'no-pair').length, 1);

  const ternary = functions.get('ternaryDecision');
  assert.equal(ternary.mcdc.decisions.length, 1, 'Ternary in return must be analyzed');
  assert.equal(ternary.scenarios.length, 3, 'Ternary in return must also produce regular branch scenarios');
  assert.equal(ternary.mcdc.decisions[0].conditions.length, 2);
  assert.ok(ternary.mcdc.decisions[0].conditions.every(item => item.independencePairs.length === 1));

  for (const name of ['whileDecision', 'forDecision']) {
    const decisions = functions.get(name).mcdc.decisions;
    assert.equal(decisions.length, 1, `${name} should expose its loop condition as an MC/DC decision`);
    assert.ok(decisions[0].conditions.every(item => item.independencePairs.length === 1));
  }

  console.log(`MC/DC tests passed: ${verifiedPairs} independence pair(s) were validated against decision and atomic-condition outcomes.`);
} finally {
  fs.rmSync(output, { force: true });
  fs.rmSync(branchOnlyOutput, { force: true });
}
