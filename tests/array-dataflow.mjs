import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const fixture = path.join(projectDir, 'examples', 'array-dataflow.js');
const output = path.join(os.tmpdir(), `branch-scenarios-dataflow-${process.pid}.json`);
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
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  const mod = await import(`${pathToFileURL(fixture).href}?dataflow=${process.pid}`);
  const get = name => {
    const fn = report.functions.find(item => item.name === name);
    assert.ok(fn, `Missing function ${name}`);
    assert.equal(fn.unsupportedBranches.length, 0, `${name}: ${JSON.stringify(fn.unsupportedBranches)}`);
    assert.ok(Array.isArray(fn.arrayPipelines) && fn.arrayPipelines.length > 0, `${name}: arrayPipelines metadata missing`);
    return fn;
  };
  const execute = (fn, scenario) => mod[fn.name](...scenario.arguments.map(revive));
  const targetScenario = (fn, condition, outcome) => {
    const scenario = fn.scenarios.find(item => item.target?.kind === 'array-predicate' &&
      item.target.condition === condition && item.target.outcome === outcome);
    assert.ok(scenario, `${fn.name}: missing ${condition} => ${outcome}`);
    return scenario;
  };
  const pipelineFor = (fn, method) => {
    const pipeline = fn.arrayPipelines.find(item => item.stages[item.stages.length - 1]?.method === method);
    assert.ok(pipeline, `${fn.name}: no pipeline ending in ${method}`);
    return pipeline;
  };
  const assertAllScenariosExecute = fn => {
    for (const scenario of fn.scenarios) {
      assert.doesNotThrow(() => execute(fn, scenario), `${fn.name}: ${scenario.id}`);
    }
  };

  // filter -> sort -> flatMap -> findLast: both filtered source records must
  // exist, and the selected last representative must map to source index 1.
  const flightFn = get('filteredSortedFlatMappedFindLast');
  const flightPipeline = pipelineFor(flightFn, 'findLast');
  assert.deepEqual(flightPipeline.stages.map(stage => stage.method), ['filter', 'sort', 'flatMap', 'findLast']);
  assert.equal(flightPipeline.stages[1].ordering, 'ascending');
  assert.equal(flightPipeline.representativeIndex, 1);
  assert.deepEqual(flightPipeline.elementAlias.path, ['input', 'flights', '1', 'passengers', '0']);
  const adult = targetScenario(flightFn, 'passenger.age >= 18', true);
  const minor = targetScenario(flightFn, 'passenger.age >= 18', false);
  for (const scenario of [adult, minor]) {
    const flights = scenario.arguments[0].flights;
    assert.equal(flights.length, 2);
    assert.ok(flights.every(flight => flight.active === true), 'all prior items must satisfy filter()');
    assert.ok(flights[0].price <= flights[1].price, 'input witnesses must preserve ascending sort order');
    assert.ok(flights[1].passengers?.[0], 'last representative must map to second source flight passenger');
  }
  assert.equal(adult.arguments[0].flights[1].passengers[0].age >= 18, true);
  assert.equal(execute(flightFn, adult), true);
  assert.equal(execute(flightFn, minor), false);
  assertAllScenariosExecute(flightFn);

  // filter -> computed map projection -> toSorted -> some.
  const mappedFn = get('filteredMappedSortedSome');
  const mappedPipeline = pipelineFor(mappedFn, 'some');
  assert.deepEqual(mappedPipeline.stages.map(stage => stage.method), ['filter', 'map', 'toSorted', 'some']);
  const scoreProjection = mappedPipeline.stages[1].projection.fields.score;
  assert.equal(scoreProjection.kind, 'computed');
  assert.equal(scoreProjection.expression, 'item.value * 2');
  assert.equal(mappedPipeline.stages[2].ordering, 'ascending');
  const mappedTrue = targetScenario(mappedFn, "entry.score >= input.minimum && entry.tag === 'ok'", true);
  const mappedFalse = targetScenario(mappedFn, "entry.score >= input.minimum && entry.tag === 'ok'", false);
  for (const scenario of [mappedTrue, mappedFalse]) {
    const items = scenario.arguments[0].items;
    assert.ok(items.every(item => item.enabled === true), 'all source items must survive filter()');
    const scores = items.map(item => item.value * 2);
    assert.ok(scores[0] <= scores[1], 'source witness must already satisfy toSorted() order');
  }
  assert.equal(execute(mappedFn, mappedTrue), true);
  assert.equal(execute(mappedFn, mappedFalse), false);
  assertAllScenariosExecute(mappedFn);

  // filter -> map(array property) -> flat -> findLastIndex.
  const flatFn = get('filteredFlatNestedFindLastIndex');
  const flatPipeline = pipelineFor(flatFn, 'findLastIndex');
  assert.deepEqual(flatPipeline.stages.map(stage => stage.method), ['filter', 'map', 'flat', 'findLastIndex']);
  assert.equal(flatPipeline.stages[2].depth, 1);
  assert.deepEqual(flatPipeline.elementAlias.path, ['input', 'groups', '0', 'people', '0']);
  const personTrue = targetScenario(flatFn, 'person.age >= input.minimumAge && person.active', true);
  const personFalse = targetScenario(flatFn, 'person.age >= input.minimumAge && person.active', false);
  for (const scenario of [personTrue, personFalse]) {
    assert.ok(scenario.arguments[0].groups.every(group => group.visible === true), 'all source groups must survive filter()');
    assert.ok(Array.isArray(scenario.arguments[0].groups[0].people));
  }
  assert.equal(execute(flatFn, personTrue), true);
  assert.equal(execute(flatFn, personFalse), false);
  assertAllScenariosExecute(flatFn);

  // Each pipeline entry must be serializable and have ordered stage indexes.
  for (const fn of report.functions) {
    for (const pipeline of fn.arrayPipelines) {
      assert.doesNotThrow(() => JSON.stringify(pipeline), `${fn.name}: pipeline must be JSON-serializable`);
      assert.deepEqual(pipeline.stages.map(stage => stage.index), pipeline.stages.map((_, index) => index));
    }
  }

  const mcdcDecisions = report.functions.flatMap(fn => fn.mcdc?.decisions ?? []);
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.pipeline?.some(stage => stage.method === 'sort')),
    'MC/DC callback context should include upstream sort dataflow');
  assert.ok(mcdcDecisions.some(decision => decision.callbackContext?.pipeline?.some(stage => stage.method === 'flat')),
    'MC/DC callback context should include upstream flat dataflow');

  console.log(`Array dataflow tests passed: ${report.functions.length} functions, ${report.functions.reduce((sum, fn) => sum + fn.scenarios.length, 0)} scenarios, ${report.functions.reduce((sum, fn) => sum + fn.arrayPipelines.length, 0)} pipeline summaries, ${report.functions.reduce((sum, fn) => sum + fn.summary.mcdcIndependencePairsFound, 0)} MC/DC pairs.`);
} finally {
  try { fs.unlinkSync(output); } catch { /* cleanup */ }
}
