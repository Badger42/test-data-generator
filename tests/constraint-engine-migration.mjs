import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'branch-scenarios.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-constraint-migration-'));

function run(name, args) {
  const output = path.join(temp, `${name}.json`);
  const result = spawnSync(process.execPath, [cli, ...args, '--out', output], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function normalize(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generatedAt;
  delete copy.constraintEngine;
  delete copy.generator.version;
  return copy;
}

try {
  const fixture = path.join(root, 'examples/passenger.js');
  const hybrid = run('hybrid', [fixture, '--function', 'getPassengerCategory', '--constraint-diagnostics']);
  const legacy = run('legacy', [fixture, '--function', 'getPassengerCategory', '--constraint-engine', 'legacy', '--constraint-diagnostics']);

  assert.equal(hybrid.constraintEngine.mode, 'hybrid');
  assert.ok(hybrid.constraintEngine.irAttempts > 0, 'hybrid mode must route supported conditions through Constraint IR');
  assert.ok(hybrid.constraintEngine.irSolved > 0, 'new Solver must produce production scenario assignments');
  assert.equal(hybrid.constraintEngine.legacyFallback, 0,
    'the passenger compatibility fixture is fully supported by Constraint IR after the path-to-path and length migration');
  assert.deepEqual(hybrid.constraintEngine.fallbackReasons, {});

  const modulo = run('modulo-arithmetic', [
    path.join(root, 'tests/fixtures/constraint-expression-modulo.ts'),
    '--function', 'moduloBranch', '--constraint-diagnostics',
  ]);
  assert.ok(modulo.constraintEngine.irSolved > 0, 'numeric modulo must now be solved through Expression IR v2');
  assert.equal(modulo.constraintEngine.legacyFallback, 0, 'supported modulo must not fall back to legacy');
  for (const scenario of modulo.functions[0].scenarios) {
    assert.equal(scenario.arguments[0].count % 2 === 0, scenario.target.outcome,
      'materialized modulo witness must reach its intended outcome');
  }

  const mutable = run('mutable-local-fallback', [
    path.join(root, 'tests/fixtures/constraint-expression-dataflow.ts'),
    '--function', 'classifyMutable', '--constraint-diagnostics',
  ]);
  assert.ok(mutable.constraintEngine.legacyFallback > 0,
    'mutable local expressions must remain visibly delegated to legacy');
  assert.ok(Object.keys(mutable.constraintEngine.fallbackReasons).length > 0);
  assert.equal(legacy.constraintEngine.mode, 'legacy');
  assert.equal(legacy.constraintEngine.irAttempts, 0, 'legacy mode must not invoke Constraint IR');
  assert.deepEqual(normalize(hybrid), normalize(legacy), 'hybrid migration must preserve the legacy JSON output on the compatibility fixture');

  const defaultMode = run('default', [fixture, '--function', 'getPassengerCategory']);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultMode, 'constraintEngine'), false, 'migration telemetry is opt-in and must not alter the default JSON contract');
  assert.equal(defaultMode.functions[0].scenarios.length, legacy.functions[0].scenarios.length);

  const mcdc = run('mcdc', [path.join(root, 'examples/mcdc.js'), '--all', '--mcdc', '--constraint-diagnostics']);
  assert.ok(mcdc.constraintEngine.mcdcIrSolved > 0,
    'supported MC/DC atom combinations must be solved jointly by Constraint IR');
  assert.equal(mcdc.constraintEngine.fallbackReasons['MC/DC atom combinations retain legacy symbolic interval merging'], undefined,
    'legacy per-atom interval merging must no longer be the default MC/DC path');
  assert.ok(mcdc.constraintEngine.legacyFallback > 0,
    'unsupported MC/DC constructs must remain visible as legacy fallbacks');

  console.log('Constraint-engine migration tests passed: IR-first routing, explicit fallback telemetry, numeric modulo solving, mutable-local fallback, legacy mode, joint IR MC/DC solving and golden-compatible output verified.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
