import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { loadTypescriptProject } from '../src/project/load-typescript-project.mjs';
import { createTypeScriptDataFlowAnalyzer } from '../src/data-flow/data-flow-analyzer.mjs';
import { buildInterproceduralSummary } from '../src/data-flow/summaries/interprocedural-summary.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-scenarios-interfile-'));
const write = (relative, content) => {
  const filename = path.join(temp, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
};

try {
  write('package.json', JSON.stringify({ type: 'module' }));
  write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: true, noEmit: true,
    },
    include: ['*.ts', 'node_modules/@demo/api/**/*.d.ts'],
  }));
  write('helper.ts', `
    export interface User { age: number; }
    export function getAge(user: User): number { return user.age; }
    export function markActive(user: User & { active?: boolean }): void { user.active = true; }
    export function recurse(user: User, depth: number): number {
      if (depth > 0) return recurse(user, depth - 1);
      return user.age;
    }
    export function recursiveGetValue(user: User): number {
      recurse(user, 1);
      return user.age;
    }
    export function normalize(value: number): number { return Math.floor(value); }
  `);
  write('barrel.ts', `export { getAge, markActive, recursiveGetValue } from './helper.js';`);
  write('node_modules/@demo/api/package.json', JSON.stringify({ name: '@demo/api', types: 'index.d.ts' }));
  write('node_modules/@demo/api/index.d.ts', `export interface RemoteUser { age: number } export function getUser(id: number): Promise<RemoteUser>;`);
  const appFile = write('app.ts', `
    import { getAge as importedGetAge, markActive, recursiveGetValue } from './barrel.js';
    import { getUser } from '@demo/api';
    import type { User } from './helper.js';

    export function isAdult(user: User): boolean {
      const age = importedGetAge(user);
      return age >= 18;
    }
    export function activatesUser(user: User): number {
      markActive(user);
      return user.age;
    }
    export function isRoundedAdult(user: User): boolean {
      const age = Math.floor(user.age);
      return age >= 18;
    }
    export function callbackMap(users: User[]): number[] {
      return users.map(user => normalize(user.age));
    }
    export async function remoteUserIsAdult(id: number): Promise<boolean> {
      const user = await getUser(id);
      return user.age >= 18;
    }
    declare function getUnknown(): { value: number; child?: { value: number } };
    export function unknownAfterReassignment(): number {
      const original = { value: 1 };
      let current = original;
      current = getUnknown();
      const alias = current;
      return original.value + alias.value;
    }
    export function unknownBeforeKnownAssignment(): number {
      const original = { value: 1 };
      let current = getUnknown();
      current = original;
      const alias = current;
      return original.value + alias.value;
    }
    export function unknownHeapStore(): number {
      const original = { value: 1 };
      const holder: { child: { value: number } } = { child: original };
      holder.child = getUnknown();
      const child = holder.child;
      return original.value + child.value;
    }
    export function unknownSpread(): number {
      const original = { value: 1 };
      const source = getUnknown();
      const copy = { ...source };
      const child = copy.child;
      return original.value + (child?.value ?? 0);
    }
    export function recursiveAlias(user: User): number {
      const value = recursiveGetValue(user);
      return value;
    }
  `);

  const project = loadTypescriptProject({ file: appFile });
  assert.ok(project.functionIndex.size >= 8, 'project-wide function index should include imported module functions');
  const sourceFile = project.sourceFile;
  const functions = new Map();
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const analyzer = createTypeScriptDataFlowAnalyzer(ts);
  const analyze = name => analyzer.analyzeWithCompilerBindings({
    project,
    functionUnit: { functionId: `${project.relativeFile}::${name}@${functions.get(name).getStart(sourceFile)}`, name, astNode: functions.get(name) },
  });

  const crossFile = analyze('isAdult');
  const helperSummary = crossFile.dataModel.functionSummaries.find(item => item.name === 'getAge');
  assert.ok(helperSummary, 'imported helper must have a project-wide summary');
  assert.equal(helperSummary.sourceSpan.file, 'helper.ts', 'summary span must use the helper file, not the root source file');
  assert.ok(crossFile.dataModel.callSites.some(item => item.callee === 'importedGetAge' && item.targetFunctionId === helperSummary.functionId),
    'renamed barrel import must resolve to the original helper declaration');
  assert.ok(!crossFile.compilerFacts.mockBindingFacts.some(item => item.callExpression === 'importedGetAge'),
    'project-local imported helpers must never be turned into mocks');
  assert.ok(crossFile.compilerFacts.expressionFacts.some(item => item.kind === 'interprocedural-return-alias' && item.targetFunctionId === helperSummary.functionId),
    'pure imported path-return helpers should supply a validated caller alias');

  const crossFileEffect = analyze('activatesUser').dataModel.interprocedural;
  assert.ok(crossFileEffect.rootEffects.some(effect => effect.path.join('.') === 'user.active' && effect.propagation === 'parameter-substitution'),
    'mutations in imported helper functions must propagate back to the caller parameter path');

  const builtin = analyze('isRoundedAdult');
  assert.ok(!builtin.compilerFacts.mockBindingFacts.some(item => item.callExpression === 'Math.floor'),
    'known pure built-ins must not be emitted as mocks');
  assert.ok(builtin.compilerFacts.expressionFacts.some(item => item.kind === 'pure-intrinsic-call' && item.callExpression === 'Math.floor'));

  const callback = analyze('callbackMap');
  assert.ok(!callback.compilerFacts.mockBindingFacts.some(item => item.callExpression === 'normalize'),
    'calls inside nested callback bodies must not leak into the enclosing function mock bindings');

  const external = analyze('remoteUserIsAdult');
  assert.ok(external.compilerFacts.mockBindingFacts.some(item => item.callExpression === 'getUser' && item.classification === 'external-dependency'),
    'package dependencies declared under node_modules should remain eligible for mock planning');

  for (const name of ['unknownAfterReassignment', 'unknownBeforeKnownAssignment']) {
    const model = analyze(name).dataModel;
    const namesById = model.pointsTo.symbols;
    const pair = model.pointsTo.aliasPairs.find(item => {
      const names = [namesById[item.leftSymbolId], namesById[item.rightSymbolId]];
      return names.includes('original') && names.includes('current');
    });
    assert.ok(pair, `${name} must retain an explicit possible alias relationship`);
    assert.notEqual(pair.relation, 'must-alias', `${name} must not retain a stale must-alias after unknown assignment`);
    assert.ok(model.pointsTo.unknownSymbols.some(id => namesById[id] === 'current'));
  }

  const heap = analyze('unknownHeapStore').dataModel;
  assert.ok(heap.pointsTo.unknownHeapFields.some(key => key.endsWith('::child')),
    'unknown value stores must widen the affected heap field');
  const childId = Object.entries(heap.pointsTo.symbols).find(([, name]) => name === 'child')?.[0];
  assert.ok(childId && heap.pointsTo.unknownSymbols.includes(childId), 'loading a top-widened heap field must mark the result unknown');
  const heapPair = heap.pointsTo.aliasPairs.find(item => [item.leftSymbolId, item.rightSymbolId].includes(childId) &&
    [heap.pointsTo.symbols[item.leftSymbolId], heap.pointsTo.symbols[item.rightSymbolId]].includes('original'));
  assert.ok(heapPair);
  assert.notEqual(heapPair.relation, 'must-alias', 'Memory SSA must not canonicalize a value loaded from an unknown heap field');

  const spread = analyze('unknownSpread').dataModel;
  assert.ok(spread.pointsTo.unknownHeapFields.some(key => key.endsWith('::*')),
    'spreading an unknown object must widen the destination wildcard field');
  const spreadChildId = Object.entries(spread.pointsTo.symbols).find(([, name]) => name === 'child')?.[0];
  assert.ok(spreadChildId && spread.pointsTo.unknownSymbols.includes(spreadChildId),
    'loads from an object spread with unknown source state must remain unknown');

  const recursive = analyze('recursiveAlias').dataModel;
  const recursiveSummary = recursive.functionSummaries.find(item => item.name === 'recursiveGetValue');
  assert.equal(recursiveSummary?.purity, 'unknown', 'recursive uncertainty must propagate to transitive callers');
  const recursiveReturn = recursive.interprocedural.returnValueFacts.find(item => item.targetFunctionId === recursiveSummary?.functionId);
  assert.equal(recursiveReturn?.usableAsConstraintAlias, false, 'a caller depending on recursion cannot provide a proven constraint alias');

  const manualRecursive = buildInterproceduralSummary([
    { functionId: 'A', name: 'A', symbolId: 'A', parameters: [], returns: [], effects: [], calls: [{ callId: 'a-b', resolvedSummaryId: 'B', arguments: [] }], purity: 'pure' },
    { functionId: 'B', name: 'B', symbolId: 'B', parameters: [], returns: [], effects: [], calls: [{ callId: 'b-b', resolvedSummaryId: 'B', arguments: [] }], purity: 'pure' },
  ], [{ callId: 'root-a', targetFunctionId: 'A', callee: 'A', arguments: [] }]);
  assert.equal(manualRecursive.summaries.find(item => item.functionId === 'A').purity, 'unknown');

  console.log('Inter-file regressions passed: project-wide imported/re-exported function summaries, pure intrinsic classification, callback boundary, external mocks, points-to top widening and recursive caller uncertainty.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
