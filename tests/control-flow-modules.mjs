import assert from 'node:assert/strict';
import ts from 'typescript';
import { createControlFlowAnalyzer } from '../src/analysis/control-flow/control-flow-analyzer.mjs';
import { createLoopAnalyzer } from '../src/analysis/loops/loop-analyzer.mjs';

const sourceFile = ts.createSourceFile('control-flow-fixture.ts', `
function sample(input) {
  if (input.enabled) {
    return 'enabled';
  } else {
    return 'disabled';
  }
}
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = sourceFile.statements.find(ts.isFunctionDeclaration);
const ifStatement = fn.body.statements[0];
const scenarios = [];

const pathWithCondition = (incoming, condition, desired) => incoming.map(item => ({
  ...item,
  outcomes: [...(item.outcomes ?? []), { expression: condition.getText(sourceFile), desired }],
}));
const noop = () => {};
const analyzer = createControlFlowAnalyzer({
  ts,
  getPath: () => ['input', 'kind'],
  getLiteral: node => ({ ok: true, value: node.text }),
  getBranchId: (kind, node) => `${kind}:${node.getStart(sourceFile)}`,
  makeAssignment: (path, value) => ({ path, value }),
  combineSolutions: (left, right) => left.flatMap(a => right.map(b => ({
    assignments: new Map([...(a.assignments ?? []), [b.path.join('.'), b.value]]),
    unsupported: [...(a.unsupported ?? []), ...(b.unsupported ?? [])],
  }))),
  unsupportedSolution: reason => [{ assignments: new Map(), unsupported: [reason] }],
  addCustomSwitchScenario: (...args) => scenarios.push(args),
  typeAtPath: () => null,
  unionMembers: () => [],
  literalForType: value => value,
  sameValue: Object.is,
  chooseDifferent: () => 'other',
  addScenarios: noop,
  pathWithCondition,
  analyzeMcdcDecision: noop,
  analyzeTernaries: noop,
  analyzeArrayCallbacksInNode: noop,
  expandCallbackLocalVariables: node => node,
  coverageAnchorMetadata: () => ({}),
  getMcdcDecisionId: () => 'decision-1',
  maxAlternatives: () => 32,
  loopPorts: {
    ts,
    getLoopCollectionPath: () => null,
    getLoopElementValue: () => ({}),
    getLoopBodyStatements: node => ts.isBlock(node) ? node.statements : [node],
    getLoopVariableName: () => null,
    getLoopInitialValue: () => ({ ok: false }),
    substituteIdentifiers: node => node,
    loopProgressesTowardExit: () => false,
    localCounterProgressesTowardExit: () => false,
    applyNumericUpdates: () => new Map(),
    addLoopScenario: noop,
    combineSolutions: (left) => left,
    makeAssignment: (path, value) => ({ path, value }),
    pathWithCondition,
    addScenarios: noop,
    analyzeMcdcDecision: noop,
    coverageAnchorMetadata: () => ({}),
    getMcdcDecisionId: () => 'decision-1',
    getBranchId: () => 'loop-1',
    cloneJson: value => JSON.parse(JSON.stringify(value)),
  },
});

const initial = [{ assignments: new Map(), unsupported: [] }];
const flow = analyzer.analyzeStatements([ifStatement], initial, {
  sourceFile,
  activeAnalysisMetadata: null,
  branchCount: 0,
  loopCount: 0,
  mcdcDecisions: [],
});
assert.equal(flow.normal.length, 0);
assert.equal(flow.returns.length, 2, 'if/else return paths should both be retained');
assert.deepEqual(flow.returns.map(item => item.outcomes[item.outcomes.length - 1].desired).sort(), [false, true]);
assert.equal(typeof analyzer.loopAnalyzer.analyzeForEachLoop, 'function');
assert.equal(typeof analyzer.loopAnalyzer.analyzeClassicForLoop, 'function');
assert.equal(typeof analyzer.loopAnalyzer.analyzeWhileLoop, 'function');

const standaloneLoopAnalyzer = createLoopAnalyzer({
  ts,
  getLoopCollectionPath: () => null,
  getLoopElementValue: () => ({}),
  getLoopBodyStatements: node => ts.isBlock(node) ? node.statements : [node],
  getLoopVariableName: () => null,
  getLoopInitialValue: () => ({ ok: false }),
  substituteIdentifiers: node => node,
  loopProgressesTowardExit: () => false,
  localCounterProgressesTowardExit: () => false,
  applyNumericUpdates: () => new Map(),
  addLoopScenario: noop,
  combineSolutions: left => left,
  makeAssignment: (path, value) => ({ path, value }),
  pathWithCondition,
  addScenarios: noop,
  analyzeMcdcDecision: noop,
  coverageAnchorMetadata: () => ({}),
  getMcdcDecisionId: () => 'decision-1',
  getBranchId: () => 'loop-1',
  cloneJson: value => JSON.parse(JSON.stringify(value)),
  walkStatements: (statements, incoming) => ({ normal: incoming, breaks: [], continues: [], returns: [] }),
  maxAlternatives: () => 16,
});
assert.equal(typeof standaloneLoopAnalyzer.analyzeWhileLoop, 'function');

console.log('Control-flow module tests passed: branch fan-out, return propagation, standalone loop ports and injected dependencies.');
