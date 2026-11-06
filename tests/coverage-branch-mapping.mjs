import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectDir, 'branch-scenarios.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-mapping-'));

function run(source, functionName, coverage, out) {
  const sourceFile = path.join(tempDir, source);
  const coverageFile = path.join(tempDir, `${functionName}.coverage-final.json`);
  fs.writeFileSync(coverageFile, JSON.stringify(coverage, null, 2));
  const result = spawnSync(process.execPath, [
    cli, sourceFile, '--function', functionName,
    '--coverage-from', coverageFile, '--out', out,
  ], { cwd: projectDir, encoding: 'utf8' });
  assert.equal(result.status, 0, `Coverage mapping CLI failed:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8')).coverageFeedback;
}

try {
  const multiSource = `export function twoIfs(input) {\n  if (input.first) return 'first';\n  if (input.second) return 'second';\n  return 'none';\n}\n`;
  const multiFile = path.join(tempDir, 'two-ifs.mjs');
  fs.writeFileSync(multiFile, multiSource);
  const multiCoverage = {
    [multiFile]: {
      path: multiFile,
      statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 39 } }, locations: [{}, {}] },
        1: { type: 'if', loc: { start: { line: 3, column: 2 }, end: { line: 3, column: 40 } }, locations: [{}, {}] },
      },
      s: {}, f: {}, b: { 0: [1, 1], 1: [1, 0] }, l: {},
    },
  };
  const multiReport = run('two-ifs.mjs', 'twoIfs', multiCoverage, path.join(tempDir, 'two-ifs.json'));
  assert.equal(multiReport.status, 'coverage-loaded');
  assert.equal(multiReport.staticBranchTargets.length, 2);
  assert.deepEqual(multiReport.staticBranchTargets.map(target => target.coverageBranchId), ['0', '1']);
  assert.ok(multiReport.staticBranchTargets.every(target => target.mappingStatus === 'exact-start'));
  assert.equal(multiReport.staticBranchTargets[0].coverageStatus, 'covered');
  assert.equal(multiReport.staticBranchTargets[1].coverageStatus, 'partially-covered');

  const switchSource = `export function switchTarget(input) {\n  switch (input.kind) {\n    case 'a': return 'A';\n    case 'b': return 'B';\n    default: return 'other';\n  }\n}\n`;
  const switchFile = path.join(tempDir, 'switch-target.mjs');
  fs.writeFileSync(switchFile, switchSource);
  const switchCoverage = {
    [switchFile]: {
      path: switchFile,
      statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'switch', loc: { start: { line: 2, column: 2 }, end: { line: 6, column: 3 } }, locations: [{}, {}, {}] },
      },
      s: {}, f: {}, b: { 0: [1, 0, 1] }, l: {},
    },
  };
  const switchReport = run('switch-target.mjs', 'switchTarget', switchCoverage, path.join(tempDir, 'switch.json'));
  assert.equal(switchReport.staticBranchTargets.length, 3);
  assert.ok(switchReport.staticBranchTargets.every(target => target.coverageBranchId === '0'));
  assert.deepEqual(switchReport.staticBranchTargets.map(target => target.outcomes[0].coverageOutcomeIndex), [0, 1, 2]);
  assert.deepEqual(switchReport.staticBranchTargets.map(target => target.coverageStatus), ['covered', 'uncovered', 'covered']);


  const loopSource = `export function loopTargets(input) {\n  while (input.count < input.limit) {\n    input.count++;\n  }\n  for (; input.loopLimit > 0;) {\n    break;\n  }\n  return input.count;\n}\n`;
  const loopFile = path.join(tempDir, 'loop-targets.mjs');
  fs.writeFileSync(loopFile, loopSource);
  const loopCoverage = {
    [loopFile]: {
      path: loopFile,
      statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 4, column: 3 } }, locations: [{}, {}] },
        1: { type: 'if', loc: { start: { line: 5, column: 2 }, end: { line: 7, column: 3 } }, locations: [{}, {}] },
      },
      s: {}, f: {}, b: { 0: [1, 1], 1: [1, 0] }, l: {},
    },
  };
  const loopReport = run('loop-targets.mjs', 'loopTargets', loopCoverage, path.join(tempDir, 'loops.json'));
  const loopTargets = loopReport.staticBranchTargets.filter(target => target.kind === 'loop');
  assert.equal(loopTargets.length, 2);
  assert.deepEqual(loopTargets.map(target => target.coverageAnchor), ['while-statement', 'for-statement']);
  assert.deepEqual(loopTargets.map(target => target.coverageBranchId), ['0', '1']);
  assert.ok(loopTargets.every(target => target.mappingStatus === 'exact-start'));



  const ternarySource = `export function ternaryTarget(input) {\n  return input.value > 0 ? 'positive' : 'other';\n}\n`;
  const ternaryFile = path.join(tempDir, 'ternary-target.mjs');
  fs.writeFileSync(ternaryFile, ternarySource);
  const ternaryReport = run('ternary-target.mjs', 'ternaryTarget', {
    [ternaryFile]: {
      path: ternaryFile, statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'cond-expr', loc: { start: { line: 2, column: 9 }, end: { line: 2, column: 26 } }, locations: [{}, {}] },
      },
      s: {}, f: {}, b: { 0: [1, 1] }, l: {},
    },
  }, path.join(tempDir, 'ternary.json'));
  const ternaryTarget = ternaryReport.staticBranchTargets.find(target => target.kind === 'ternary');
  assert.ok(ternaryTarget);
  assert.equal(ternaryTarget.mappingStatus, 'exact-start');
  assert.equal(ternaryTarget.coverageBranchId, '0');


  const realPathSource = `export function realPathTarget(input) {\n  if (input.enabled) return true;\n  return false;\n}\n`;
  const realPathFile = path.join(tempDir, 'real-path-target.mjs');
  const symlinkFile = path.join(tempDir, 'real-path-link.mjs');
  fs.writeFileSync(realPathFile, realPathSource);
  try {
    fs.symlinkSync(realPathFile, symlinkFile);
    const realPathReport = run('real-path-link.mjs', 'realPathTarget', {
      [realPathFile]: {
        path: realPathFile, statementMap: {}, fnMap: {},
        branchMap: { 0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 36 } }, locations: [{}, {}] } },
        s: {}, f: {}, b: { 0: [1, 1] }, l: {},
      },
    }, path.join(tempDir, 'real-path.json'));
    assert.equal(realPathReport.sourceFileMatch, 'absolute-path', 'the CLI canonicalizes source symlinks before coverage matching');
    assert.equal(realPathReport.staticBranchTargets[0].coverageStatus, 'covered');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }

  const arraySource = `export function arrayTargets(input) {\n  return input.items.some(item => item.active);\n}\n`;
  const arrayFile = path.join(tempDir, 'array-targets.mjs');
  fs.writeFileSync(arrayFile, arraySource);
  const arrayReport = run('array-targets.mjs', 'arrayTargets', {
    [arrayFile]: { path: arrayFile, statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {}, l: {} },
  }, path.join(tempDir, 'arrays.json'));
  const syntheticArrayTargets = arrayReport.staticBranchTargets.filter(target => String(target.loopType ?? '').startsWith('array-'));
  assert.ok(syntheticArrayTargets.length > 0);
  assert.ok(syntheticArrayTargets.every(target => target.coverageStatus === 'not-applicable' && target.mappingStatus === 'not-applicable'));

  // Jest 30's V8 provider converts source ranges to one-counter Istanbul entries
  // (type 'branch'), not semantic two-outcome 'if' entries.
  const v8IfSource = "export function v8IfTarget(input) {\n  if (input.enabled && input.score >= 10) return 'active';\n  return 'inactive';\n}";
  const v8IfFile = path.join(tempDir, 'v8-if-target.mjs');
  fs.writeFileSync(v8IfFile, v8IfSource);
  const v8IfReport = run('v8-if-target.mjs', 'v8IfTarget', {
    [v8IfFile]: {
      path: v8IfFile, statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'branch', loc: { start: { line: 2, column: 6 }, end: { line: 2, column: 40 } }, locations: [{ start: { line: 2, column: 6 }, end: { line: 2, column: 40 } }] },
        1: { type: 'branch', loc: { start: { line: 2, column: 6 }, end: { line: 2, column: 19 } }, locations: [{ start: { line: 2, column: 6 }, end: { line: 2, column: 19 } }] },
        2: { type: 'branch', loc: { start: { line: 2, column: 20 }, end: { line: 2, column: 40 } }, locations: [{ start: { line: 2, column: 20 }, end: { line: 2, column: 40 } }] },
      },
      s: {}, f: {}, b: { 0: [5], 1: [5], 2: [3] }, l: {},
    },
  }, path.join(tempDir, 'v8-if.json'));
  const v8IfTarget = v8IfReport.staticBranchTargets.find(target => target.kind === 'if');
  assert.ok(v8IfTarget);
  assert.equal(v8IfTarget.coverageBranchId, '0', 'the full V8 condition range must win over nested atom ranges');
  assert.equal(v8IfTarget.mappingStatus, 'v8-condition-range-only');
  assert.equal(v8IfTarget.coverageStatus, 'partially-covered');
  assert.equal(v8IfTarget.coverageOutcomeMapping, 'not-available-from-v8-range-map');
  assert.ok(v8IfTarget.outcomes.every(outcome => outcome.covered === null), 'a single V8 range counter must not be misrepresented as true/false outcome coverage');
  // Two equally good Istanbul candidates must be reported as ambiguous,
  // rather than silently assigning the first entry.
  const ambiguousCoverage = {
    [multiFile]: {
      path: multiFile,
      statementMap: {}, fnMap: {},
      branchMap: {
        0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 39 } }, locations: [{}, {}] },
        1: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 39 } }, locations: [{}, {}] },
      },
      s: {}, f: {}, b: { 0: [1, 1], 1: [1, 1] }, l: {},
    },
  };
  const ambiguousReport = run('two-ifs.mjs', 'twoIfs', ambiguousCoverage, path.join(tempDir, 'ambiguous.json'));
  assert.equal(ambiguousReport.staticBranchTargets[0].coverageStatus, 'ambiguous');
  assert.equal(ambiguousReport.staticBranchTargets[0].mappingStatus, 'ambiguous');
  assert.equal(ambiguousReport.staticBranchTargets[0].coverageBranchId, null);

  console.log('Coverage branch mapping tests passed: Istanbul semantic branches, Jest V8 condition ranges, loops, ternaries, switch clauses, synthetic array-cardinality targets and ambiguous mappings are handled without guessing.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
