import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createTypeScriptDataFlowAnalyzer } from '../src/data-flow/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/data-flow-engine.ts');
const program = ts.createProgram([fixture], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
});
const sourceFile = program.getSourceFile(fixture);
const checker = program.getTypeChecker();
const functions = new Map();
const visit = node => {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
  ts.forEachChild(node, visit);
};
visit(sourceFile);
const analyzer = createTypeScriptDataFlowAnalyzer(ts);
const analyze = name => analyzer.analyze({
  project: { sourceFile, checker, relativeFile: 'tests/fixtures/data-flow-engine.ts' },
  functionUnit: { functionId: `ssa-memory:${name}`, name, astNode: functions.get(name) },
});

const branch = analyze('ssaVersionedBranch');
const versioned = branch.ssa.versioned;
assert.equal(versioned.algorithm, 'cytron-iterated-dominance-frontier-dominator-tree-renaming');
assert.equal(versioned.convergence.allReachableNodesVisited, true);
const selectedPhi = versioned.phiNodes.find(item => item.name === 'selected');
assert.ok(selectedPhi, 'branch-assigned local variable must receive a Cytron phi');
assert.equal(selectedPhi.complete, true, 'both CFG predecessors must have concrete SSA versions');
assert.equal(new Set(selectedPhi.inputs.map(item => item.value)).size, 2, 'branch phi operands must retain distinct reaching versions');
const selectedUse = versioned.useBindings.find(item => item.name === 'selected' && item.nodeId !== selectedPhi.nodeId);
assert.ok(selectedUse?.value, 'post-join use must resolve to a versioned SSA value');
assert.equal(selectedUse.value, selectedPhi.output, 'post-join use must resolve to the phi output');

const loop = analyze('ssaVersionedLoop');
const totalPhi = loop.ssa.versioned.phiNodes.find(item => item.name === 'total' && item.kind === 'loop-carried');
assert.ok(totalPhi, 'loop-carried total must receive a loop-header phi');
assert.equal(totalPhi.complete, true, 'loop phi must include preheader and backedge values');
assert.ok(totalPhi.inputs.some(item => item.value !== totalPhi.output), 'loop phi must include a pre-loop incoming version');
assert.ok(totalPhi.inputs.some(item => item.value && item.value !== totalPhi.inputs[0].value), 'loop phi must distinguish the backedge version');

const heapBranch = analyze('heapVersionedBranch');
assert.equal(heapBranch.memorySsa.algorithm, 'field-sensitive-overlap-aware-cytron-memory-ssa');
const scoreLocation = heapBranch.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'user.score');
assert.ok(scoreLocation, 'nested property reads must create a field-sensitive memory location');
const scorePhi = heapBranch.memorySsa.phiNodes.find(item => item.symbolId === scoreLocation.id);
assert.ok(scorePhi, 'mutations from both branches must merge through memory phi');
assert.equal(scorePhi.complete, true, 'memory phi must include both branch predecessor versions');
assert.ok(heapBranch.memorySsa.useBindings.some(item => item.symbolId === scoreLocation.id && item.value === scorePhi.output), 'read after branch must bind to the heap phi output');

const heapAlias = analyze('heapVersionedAlias');
const aliasLocation = heapAlias.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'user.score');
assert.ok(aliasLocation, 'alias-normalized property read must reuse the original object location');
assert.ok(heapAlias.memorySsa.accesses.some(item => item.kind === 'write' && item.location === aliasLocation.id), 'write through a must-alias must update the original object location');
assert.ok(heapAlias.memorySsa.accesses.some(item => item.kind === 'read' && item.location === aliasLocation.id), 'read through the original parameter must see the alias-normalized location');

const heapDynamic = analyze('heapVersionedDynamicIndex');
assert.ok(heapDynamic.memorySsa.accesses.some(item => item.effectKind === 'dynamic-index-write' && item.updateMode === 'weak'), 'dynamic index mutation must create a conservative wildcard weak update');
assert.ok(heapDynamic.memorySsa.diagnostics.every(item => !['HEAP_WRITE_WITHOUT_CFG_NODE'].includes(item.code)));

const heapMayAlias = analyze('heapVersionedMayAlias');
const originalUserLocation = heapMayAlias.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'user.score');
const otherLocation = heapMayAlias.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'other.score');
assert.ok(originalUserLocation && otherLocation, 'may-alias paths must remain distinct abstract memory locations');
assert.ok(heapMayAlias.memorySsa.accesses.some(item => item.kind === 'write' && item.location === otherLocation.id && item.updateMode === 'weak'), 'may-alias candidate effects must be represented as weak updates');
assert.ok(!heapMayAlias.memorySsa.accesses.some(item => item.kind === 'write' && item.location === originalUserLocation.id && item.updateMode === 'strong'), 'a reassigned may-alias must never become a strong update to the old target');

const heapTemporalAlias = analyze('heapVersionedTemporalAlias');
const temporalUser = heapTemporalAlias.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'user.score');
const temporalOther = heapTemporalAlias.memorySsa.locations.find(item => item.rootName === 'input' && item.path.join('.') === 'other.score');
assert.ok(temporalUser && temporalOther, 'temporal alias changes must preserve both target locations');
const userWrites = heapTemporalAlias.memorySsa.accesses.filter(item => item.kind === 'write' && item.location === temporalUser.id);
const otherWrites = heapTemporalAlias.memorySsa.accesses.filter(item => item.kind === 'write' && item.location === temporalOther.id);
assert.ok(userWrites.some(item => item.updateMode === 'weak'), 'the write before reassignment must target the earlier alias value');
assert.ok(otherWrites.some(item => item.updateMode === 'weak'), 'the write after reassignment must target the later alias value');

for (const model of [branch, loop, heapBranch, heapAlias, heapDynamic, heapMayAlias, heapTemporalAlias]) {
  assert.doesNotThrow(() => JSON.stringify(model), 'SSA and memory SSA outputs must be JSON-safe');
}
console.log('SSA/Memory SSA tests passed: Cytron phi placement, dominator-tree renaming, loop-carried versions, field-sensitive heap phi, alias normalization and dynamic-index weak updates.');
