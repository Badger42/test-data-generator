import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from '../src/cli/parse-args.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-input-regressions-'));
const cli = path.join(root, 'branch-scenarios.mjs');
const fixture = path.join(root, 'tests', 'fixtures', 'edge-case-guards.ts');
function run(source, functionName, output) {
  const result = spawnSync(process.execPath, [cli, source, '--function', functionName, '--out', output], {
    cwd: root, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.status, 0, `Generation failed for ${functionName}:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}
try {
  assert.throws(() => parseCliArgs(['input.js', '--function']), /--function requires a value/);
  assert.throws(() => parseCliArgs(['input.js', '--out']), /--out requires a value/);

  const malformed = path.join(temp, 'malformed.ts');
  const malformedOutput = path.join(temp, 'malformed.json');
  fs.writeFileSync(malformed, 'export function bad( {');
  const syntaxRun = spawnSync(process.execPath, [cli, malformed, '--out', malformedOutput], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(syntaxRun.status, 0, 'a syntactically invalid source file must fail the CLI');
  assert.match(syntaxRun.stderr, /syntax error/i);
  assert.equal(fs.existsSync(malformedOutput), false, 'syntax errors must not produce a successful empty report');

  const nestedOutput = path.join(temp, 'missing', 'nested', 'output.json');
  const nestedRun = spawnSync(process.execPath, [cli, fixture, '--function', 'moduloFifteen', '--out', nestedOutput], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(nestedRun.status, 0, 'the --out path must not silently create missing directories');
  assert.match(nestedRun.stderr, /output directory does not exist/i);
  assert.equal(fs.existsSync(path.dirname(nestedOutput)), false);

  const destructured = run(fixture, 'destructuredGuard', path.join(temp, 'destructured.json'));
  const destructuredFunction = destructured.functions[0];
  assert.equal(destructuredFunction.scenarios.length, 0, 'unsupported destructured arguments must not be fabricated as null');
  assert.equal(destructuredFunction.unsupportedParameters.length, 1);
  assert.ok(destructuredFunction.unsupportedBranches.length > 0);
  assert.match(destructuredFunction.unsupportedParameters[0].reason, /Destructured parameters are not yet mapped/);

  const modulo = run(fixture, 'moduloFifteen', path.join(temp, 'modulo.json'));
  const trueScenario = modulo.functions[0].scenarios.find(item => item.target.outcome === true);
  assert.ok(trueScenario, 'the conjunction of modulo constraints must have a feasible true witness');
  assert.equal(trueScenario.arguments[0].n, 15, 'n=15 is a concrete witness for divisibility by both 3 and 5');

  const unsupported = run(fixture, 'unsupportedTypeof', path.join(temp, 'typeof.json'));
  const unsupportedFunction = unsupported.functions[0];
  assert.equal(unsupportedFunction.scenarios.length, 0, 'unsupported typeof semantics must not emit guessed candidate values');
  assert.ok(unsupportedFunction.unsupportedBranches.length > 0, 'unsupported outcomes must remain visible in the report');

  console.log('Input validation and solver regressions passed: malformed source, missing CLI values, output-path safety, destructured parameters, modulo witness n=15 and unsupported typeof outcome.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
