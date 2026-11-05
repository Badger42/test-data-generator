import assert from 'node:assert/strict';
import ts from 'typescript';
import { createExpressionTraversal } from '../src/analysis/ast-traversal/expression-traversal.mjs';

const sourceFile = ts.createSourceFile(
  'expression.ts',
  'function choose(flag: boolean, nested: boolean) { return flag ? (nested ? 1 : 2) : 3; }',
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const fn = sourceFile.statements[0];
const expression = fn.body.statements[0].expression;
const decisions = [];
const branches = [];
const traversal = createExpressionTraversal({
  ts,
  analyzeMcdcDecision(condition, incoming, ctx, kind) {
    decisions.push({ text: condition.getText(sourceFile), kind, depth: incoming.length ? incoming[0].length : 0 });
  },
  getMcdcDecisionId(kind, condition) { return `${kind}:${condition.getStart(sourceFile)}`; },
  addScenarios(ctx, branchKind, condition, text, desired, incoming, _label, _solveNode, metadata) {
    branches.push({ branchKind, text, desired, runtimeDecisionId: metadata.runtimeDecisionId, pathCount: incoming.length });
  },
  pathWithCondition(incoming, condition, desired) {
    return incoming.map(path => [...path, { condition: condition.getText(sourceFile), desired }]);
  },
});

traversal.analyzeTernaries(expression, [[]], { sourceFile });
assert.deepEqual(decisions.map(item => item.text), ['flag', 'nested']);
assert.equal(decisions.length, 2);
assert.equal(branches.length, 4);
assert.deepEqual(branches.map(item => item.desired), [true, false, true, false]);
assert.equal(branches[2].runtimeDecisionId.startsWith('ternary:'), true);
assert.equal(branches[2].pathCount, 1);
console.log('Expression traversal passed: nested conditional expressions preserve source-order and path context.');
