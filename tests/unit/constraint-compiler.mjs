import assert from 'node:assert/strict';
import ts from 'typescript';
import { compileTypescriptCondition } from '../../src/constraints/compile-typescript-condition.mjs';
import { CONSTRAINT_UNDEFINED, validateConstraintIR } from '../../src/constraints/constraint-ir.mjs';
import { ConstraintSolver, evaluateConstraint } from '../../src/solver/constraint-solver.mjs';

function compile(expression) {
  const source = ts.createSourceFile('fixture.ts', `function f(input: any) { return ${expression}; }`, ts.ScriptTarget.Latest, true);
  const returnStatement = source.statements[0].body.statements[0];
  return compileTypescriptCondition(returnStatement.expression, ts);
}

const compound = compile('input.age >= 18 && input.active');
assert.equal(validateConstraintIR(compound).valid, true);
assert.equal(compound.atoms.length, 2);
assert.deepEqual(compound.atoms[0].path, ['input', 'age']);
assert.equal(compound.atoms[0].operator, '>=');
assert.equal(compound.atoms[0].value, 18);
assert.ok(compound.atoms[0].source.start >= 0);

const solver = new ConstraintSolver();
const result = solver.solve(compound);
assert.equal(result.status, 'solved');
assert.equal(evaluateConstraint(compound.expression, result.assignments), true);

const reverse = compile('18 <= input.age');
assert.equal(reverse.atoms[0].operator, '>=');
assert.deepEqual(reverse.atoms[0].path, ['input', 'age']);

const negative = compile('input.balance < -2');
assert.equal(negative.atoms[0].value, -2);

const undefinedCheck = compile('input.nickname === undefined');
assert.deepEqual(undefinedCheck.atoms[0].value, CONSTRAINT_UNDEFINED);

const pathComparisonSource = ts.createSourceFile('paths.ts', 'function f(input: any) { return input.count < input.limit; }', ts.ScriptTarget.Latest, true);
const pathComparison = compileTypescriptCondition(pathComparisonSource.statements[0].body.statements[0].expression, ts, {
  pathTypes: { 'input.count': 'number', 'input.limit': 'number' },
});
assert.deepEqual(pathComparison.atoms[0].path, ['input', 'count']);
assert.deepEqual(pathComparison.atoms[0].valuePath, ['input', 'limit']);
assert.deepEqual(pathComparison.atoms[0].valuePathTypeHint, { kind: 'number' });
const pathComparisonSolved = solver.solve(pathComparison);
assert.equal(pathComparisonSolved.status, 'solved');
assert.ok(pathComparisonSolved.assignments.input.count < pathComparisonSolved.assignments.input.limit);

const typed = ts.createSourceFile('typed.ts', 'function f(input: any) { return input.items; }', ts.ScriptTarget.Latest, true);
const typedExpr = typed.statements[0].body.statements[0].expression;
const typedIr = compileTypescriptCondition(typedExpr, ts, { pathTypes: { 'input.items': { kind: 'array', optional: true } } });
assert.equal(typedIr.atoms[0].pathType, 'array');
assert.deepEqual(typedIr.atoms[0].pathTypeHint, { kind: 'array', optional: true });
assert.equal(solver.solve(typedIr, { desired: false }).status, 'solved');
const literalUnionIr = compileTypescriptCondition(typedExpr, ts, {
  pathTypes: { 'input.items': { kind: 'array', optional: true } },
});
assert.deepEqual(literalUnionIr.atoms[0].pathTypeHint, { kind: 'array', optional: true });
const roleSource = ts.createSourceFile('role.ts', `function f(input: any) { return input.role === 'admin'; }`, ts.ScriptTarget.Latest, true);
const roleExpression = roleSource.statements[0].body.statements[0].expression;
const roleIr = compileTypescriptCondition(roleExpression, ts, {
  pathTypes: { 'input.role': { kind: 'string', allowedValues: ['admin', 'owner'] } },
});
assert.deepEqual(roleIr.atoms[0].pathTypeHint, { kind: 'string', allowedValues: ['admin', 'owner'] });
assert.equal(validateConstraintIR(roleIr).valid, true);
assert.throws(() => compileTypescriptCondition(roleExpression, ts, {
  pathTypes: { 'input.role': { kind: 'string', allowedValues: ['admin', 1] } },
}), /Literal path values|Invalid path type hint/);

const lengthSource = ts.createSourceFile('length.ts', 'function f(input: any) { return input.items.length > 0; }', ts.ScriptTarget.Latest, true);
const length = compileTypescriptCondition(lengthSource.statements[0].body.statements[0].expression, ts, {
  pathTypes: { 'input.items': 'array' },
});
assert.deepEqual(length.atoms[0].path, ['input', 'items']);
assert.equal(length.atoms[0].accessor, 'length');
const lengthCompiledSolved = solver.solve(length);
assert.equal(lengthCompiledSolved.status, 'solved');
assert.ok(lengthCompiledSolved.assignments.input.items.length > 0);

const unsupported = compile('isAllowed(input)');
assert.equal(unsupported.atoms[0].operator, 'unsupported');
assert.ok(unsupported.diagnostics.some(item => item.code === 'UNSUPPORTED_EXPRESSION'));
assert.equal(solver.solve(unsupported).status, 'unsupported');

const constantBoolean = compile('false');
assert.equal(constantBoolean.expression.kind, 'constant');
assert.equal(constantBoolean.expression.value, false);



// Numeric expression IR: the compiler lowers arithmetic without leaking TS nodes.
const arithmeticSource = ts.createSourceFile('arithmetic.ts',
  'function f(input: { price: number; quantity: number }) { return input.price * input.quantity + 5 > 100; }',
  ts.ScriptTarget.Latest, true);
const arithmeticNode = arithmeticSource.statements[0].body.statements[0].expression;
const arithmeticIr = compileTypescriptCondition(arithmeticNode, ts, {
  pathTypes: { 'input.price': 'number', 'input.quantity': 'number' },
  isNumericExpression: expression => Boolean(ts.isBinaryExpression(expression) || ts.isPropertyAccessExpression(expression)),
});
assert.equal(arithmeticIr.irVersion, 2);
assert.equal(arithmeticIr.atoms[0].leftExpression.kind, 'binary');
assert.equal(validateConstraintIR(arithmeticIr).valid, true);
const arithmeticResult = solver.solveAll(arithmeticIr, { maxCandidates: 4096, maxSolutions: 4, solutionsPerClause: 1 });
assert.equal(arithmeticResult.status, 'solved');
assert.ok(evaluateConstraint(arithmeticIr.expression, arithmeticResult.assignments));
assert.ok(arithmeticResult.assignments.input.price * arithmeticResult.assignments.input.quantity + 5 > 100);

const affineSource = ts.createSourceFile('affine.ts',
  'function f(input: { amount: number }) { return -input.amount / 2 + 10 >= 30; }',
  ts.ScriptTarget.Latest, true);
const affineIr = compileTypescriptCondition(affineSource.statements[0].body.statements[0].expression, ts, {
  pathTypes: { 'input.amount': 'number' },
  isNumericExpression: () => true,
});
const affineResult = solver.solve(affineIr, { maxCandidates: 4096 });
assert.equal(affineResult.status, 'solved');
assert.ok(-affineResult.assignments.input.amount / 2 + 10 >= 30);

const expressionNoWitness = solver.solveAll(arithmeticIr, { desired: true, maxCandidates: 1, maxSolutions: 1 });
assert.ok(['solved', 'limit-reached', 'unsupported'].includes(expressionNoWitness.status));

const stringAdditionSource = ts.createSourceFile('string-addition.ts',
  'function f(input: { first: string; last: string }) { return input.first + input.last > 4; }',
  ts.ScriptTarget.Latest, true);
const stringAdditionIr = compileTypescriptCondition(stringAdditionSource.statements[0].body.statements[0].expression, ts);
assert.equal(stringAdditionIr.atoms[0].operator, 'unsupported',
  'numeric Expression IR must not assume that untyped JavaScript + means addition instead of concatenation');

console.log('Constraint TypeScript compiler tests passed.');
