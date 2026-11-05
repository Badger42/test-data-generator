import assert from 'node:assert/strict';
import {
  CONSTRAINT_UNDEFINED,
  atom,
  constant,
  createConstraintIR,
  logical,
  negate,
  validateConstraintExpr,
  validateConstraintIR,
} from '../../src/constraints/constraint-ir.mjs';
import { ConstraintSolver, evaluateConstraint } from '../../src/solver/constraint-solver.mjs';

const solver = new ConstraintSolver();
const age = atom({ id: 'C1', path: ['passenger', 'age'], operator: '>=', value: 18 });
const active = atom({ id: 'C2', path: ['passenger', 'active'], operator: 'truthy' });
const expr = logical('and', [age, active]);
const ir = createConstraintIR(expr);

assert.equal(validateConstraintExpr(expr).valid, true);
assert.equal(validateConstraintIR(ir).valid, true);
assert.equal(evaluateConstraint(expr, { passenger: { age: 20, active: true } }), true);
assert.equal(evaluateConstraint(expr, { passenger: { age: 17, active: true } }), false);

const solved = solver.solve(ir);
assert.equal(solved.status, 'solved');
assert.equal(evaluateConstraint(expr, solved.assignments), true);
assert.ok(solved.assignments.passenger.age >= 18);
assert.equal(solved.assignments.passenger.active, true);

const falseSolved = solver.solve(ir, { desired: false });
assert.equal(falseSolved.status, 'solved');
assert.equal(evaluateConstraint(expr, falseSolved.assignments), false);

const negated = negate(active);
assert.equal(validateConstraintExpr(negated).valid, true);
const negatedSolved = solver.solve(createConstraintIR(negated));
assert.equal(negatedSolved.status, 'solved');
assert.equal(evaluateConstraint(negated, negatedSolved.assignments), true);

const either = logical('or', [age, active]);
const eitherSolved = solver.solve(createConstraintIR(either));
assert.equal(eitherSolved.status, 'solved');
assert.equal(evaluateConstraint(either, eitherSolved.assignments), true);

// Numeric candidate partitions must include thresholds and adjacent representable values.
const narrowInterval = logical('and', [
  atom({ id: 'N1', path: ['x'], operator: '>', value: 10 }),
  atom({ id: 'N2', path: ['x'], operator: '<', value: 11 }),
]);
const narrowSolved = solver.solve(createConstraintIR(narrowInterval));
assert.equal(narrowSolved.status, 'solved');
assert.ok(narrowSolved.assignments.x > 10 && narrowSolved.assignments.x < 11);

const impossibleInterval = logical('and', [
  atom({ id: 'N3', path: ['x'], operator: '>', value: 10 }),
  atom({ id: 'N4', path: ['x'], operator: '<', value: 10 }),
]);
const impossible = solver.solve(createConstraintIR(impossibleInterval));
assert.equal(impossible.status, 'unsatisfiable');

const conflictingEquality = logical('and', [
  atom({ id: 'E1', path: ['x'], operator: '===', value: 'first' }),
  atom({ id: 'E2', path: ['x'], operator: '===', value: 'second' }),
]);
assert.equal(solver.solve(createConstraintIR(conflictingEquality)).status, 'unsatisfiable');

// A nested branch guard must be solved without trying to assign a property to a primitive.
const nested = logical('and', [
  atom({ id: 'P1', path: ['passenger'], operator: 'truthy' }),
  atom({ id: 'P2', path: ['passenger', 'age'], operator: '>=', value: 18 }),
]);
const nestedSolved = solver.solve(createConstraintIR(nested));
assert.equal(nestedSolved.status, 'solved');
assert.equal(evaluateConstraint(nested, nestedSolved.assignments), true);
assert.equal(typeof nestedSolved.assignments.passenger, 'object');
assert.ok(nestedSolved.assignments.passenger.age >= 18);

// Missing optional property is materialized by omission, not by a fake JSON value.
const undefinedCheck = atom({ id: 'U1', path: ['passenger', 'middleName'], operator: '===', value: CONSTRAINT_UNDEFINED });
const undefinedSolved = solver.solve(createConstraintIR(undefinedCheck));
assert.equal(undefinedSolved.status, 'solved');
assert.equal(Object.prototype.hasOwnProperty.call(undefinedSolved.assignments.passenger, 'middleName'), false);
assert.equal(evaluateConstraint(undefinedCheck, undefinedSolved.assignments), true);
const rootUndefined = atom({ id: 'U2', path: ['passenger'], operator: '===', value: CONSTRAINT_UNDEFINED });
const rootUndefinedSolved = solver.solve(createConstraintIR(rootUndefined));
assert.equal(rootUndefinedSolved.status, 'solved');
assert.deepEqual(rootUndefinedSolved.assignments.passenger, { $undefined: true });
assert.equal(evaluateConstraint(rootUndefined, rootUndefinedSolved.assignments), true);

// The seed is a soft starting point and must never be mutated by search.
const seed = { passenger: { age: 12, active: false } };
const seedBefore = JSON.stringify(seed);
const seeded = solver.solve(ir, { seed });
assert.equal(seeded.status, 'solved');
assert.equal(JSON.stringify(seed), seedBefore);
assert.equal(evaluateConstraint(expr, seeded.assignments), true);

// Parent/child paths with a short-circuit guard remain safe.
const guardedFalse = solver.solve(createConstraintIR(nested), { desired: false });
assert.equal(guardedFalse.status, 'solved');
assert.equal(evaluateConstraint(nested, guardedFalse.assignments), false);

// The solver must not claim unsatisfiable for constructs it cannot solve faithfully.
const pathComparison = atom({ id: 'R1', path: ['input', 'count'], pathTypeHint: { kind: 'number' },
  valuePath: ['input', 'limit'], valuePathTypeHint: { kind: 'number' }, operator: '<' });
const pathComparisonResult = solver.solve(createConstraintIR(pathComparison));
assert.equal(pathComparisonResult.status, 'solved');
assert.ok(pathComparisonResult.assignments.input.count < pathComparisonResult.assignments.input.limit);
assert.equal(solver.solve(createConstraintIR(pathComparison), { desired: false }).status, 'solved');
const pathComparisonFalseWitnesses = solver.solveAll(createConstraintIR(pathComparison), {
  desired: false, maxSolutions: 8, solutionsPerClause: 1,
});
assert.equal(pathComparisonFalseWitnesses.status, 'solved');
assert.ok(pathComparisonFalseWitnesses.solutions.some(value => value.input.count > value.input.limit));
assert.ok(pathComparisonFalseWitnesses.solutions.some(value => value.input.count === value.input.limit));

const impossiblePathComparison = logical('and', [
  atom({ id: 'R2', path: ['a'], pathTypeHint: { kind: 'number' }, valuePath: ['b'], valuePathTypeHint: { kind: 'number' }, operator: '<' }),
  atom({ id: 'R3', path: ['b'], pathTypeHint: { kind: 'number' }, valuePath: ['a'], valuePathTypeHint: { kind: 'number' }, operator: '<' }),
]);
assert.equal(solver.solve(createConstraintIR(impossiblePathComparison)).status, 'unsatisfiable');

const equalityPathComparison = atom({ id: 'R4', path: ['left'], pathTypeHint: { kind: 'string', allowedValues: ['alpha', 'beta'] },
  valuePath: ['right'], valuePathTypeHint: { kind: 'string', allowedValues: ['alpha', 'beta'] }, operator: '===' });
const equalityPathResult = solver.solve(createConstraintIR(equalityPathComparison));
assert.equal(equalityPathResult.status, 'solved');
assert.equal(equalityPathResult.assignments.left, equalityPathResult.assignments.right);

const typedArrayTruthiness = atom({ id: 'A1', path: ['input', 'items'], operator: 'truthy', pathType: 'array' });
const typedArraySolved = solver.solve(createConstraintIR(typedArrayTruthiness));
assert.equal(typedArraySolved.status, 'solved');
assert.ok(Array.isArray(typedArraySolved.assignments.input.items));
assert.equal(typedArraySolved.assignments.input.items.length, 0);
const invalidPathHints = solver.solve(createConstraintIR(typedArrayTruthiness), { pathTypes: { 'input.items': 'date' } });
assert.equal(invalidPathHints.status, 'unsupported');
assert.equal(solver.solve(createConstraintIR(typedArrayTruthiness), { desired: false }).status, 'unsatisfiable');
const requiredArrayNull = atom({ id: 'A2', path: ['input', 'items'], operator: '===', value: null, pathTypeHint: { kind: 'array' } });
assert.equal(solver.solve(createConstraintIR(requiredArrayNull)).status, 'unsatisfiable');
const nullableArrayNull = atom({ id: 'A3', path: ['input', 'items'], operator: '===', value: null, pathTypeHint: { kind: 'array', nullable: true } });
const nullableArrayResult = solver.solve(createConstraintIR(nullableArrayNull));
assert.equal(nullableArrayResult.status, 'solved');
assert.equal(nullableArrayResult.assignments.input.items, null);
const optionalArrayFalse = solver.solve(createConstraintIR(typedArrayTruthiness), {
  desired: false,
  pathTypes: { 'input.items': { kind: 'array', optional: true } },
});
assert.equal(optionalArrayFalse.status, 'solved');
assert.equal(solver.solve(createConstraintIR(typedArrayTruthiness), { pathTypes: { 'input.items': { kind: 'array', optional: 'yes' } } }).status, 'unsupported');
const accessorPathHints = Object.defineProperty({}, 'input.items', { enumerable: true, get() { throw new Error('must not execute'); } });
assert.equal(solver.solve(createConstraintIR(typedArrayTruthiness), { pathTypes: accessorPathHints }).status, 'unsupported');
assert.equal(Object.prototype.hasOwnProperty.call(optionalArrayFalse.assignments.input, 'items'), false);

const lengthComparison = atom({ id: 'L1', path: ['items'], accessor: 'length', operator: '>', value: 0,
  pathTypeHint: { kind: 'array' } });
const lengthSolved = solver.solve(createConstraintIR(lengthComparison));
assert.equal(lengthSolved.status, 'solved');
assert.ok(Array.isArray(lengthSolved.assignments.items));
assert.ok(lengthSolved.assignments.items.length > 0);
assert.equal(solver.solve(createConstraintIR(lengthComparison), { desired: false }).status, 'solved');

const lengthInterval = logical('and', [
  atom({ id: 'L2', path: ['items'], accessor: 'length', operator: '>=', value: 2, pathTypeHint: { kind: 'array' } }),
  atom({ id: 'L3', path: ['items'], accessor: 'length', operator: '<', value: 4, pathTypeHint: { kind: 'array' } }),
]);
const lengthIntervalSolved = solver.solveAll(createConstraintIR(lengthInterval));
assert.equal(lengthIntervalSolved.status, 'solved');
assert.ok(lengthIntervalSolved.solutions.every(value => value.items.length >= 2 && value.items.length < 4));
assert.equal(lengthIntervalSolved.solutionDomains[0][0].kind, 'integer-length');

const stringLength = atom({ id: 'L4', path: ['code'], accessor: 'length', operator: '===', value: 3,
  pathTypeHint: { kind: 'string' } });
const stringLengthSolved = solver.solve(createConstraintIR(stringLength));
assert.equal(stringLengthSolved.status, 'solved');
assert.equal(stringLengthSolved.assignments.code.length, 3);
const unsupportedLargeLength = atom({ id: 'L5', path: ['items'], accessor: 'length', operator: '>', value: 8, pathTypeHint: { kind: 'array' } });
assert.equal(solver.solve(createConstraintIR(unsupportedLargeLength)).status, 'unsupported');

// A combined interval can require length 9 even when no individual literal
// exceeds the materializer cap. This is not a proof of unsatisfiability.
const lengthBeyondCap = logical('and', [
  atom({ id: 'L7', path: ['items'], accessor: 'length', operator: '>=', value: 8, pathTypeHint: { kind: 'array' } }),
  atom({ id: 'L8', path: ['items'], accessor: 'length', operator: '!==', value: 8, pathTypeHint: { kind: 'array' } }),
]);
assert.equal(solver.solve(createConstraintIR(lengthBeyondCap)).status, 'limit-reached');
assert.equal(solver.solveAll(createConstraintIR(lengthBeyondCap)).status, 'limit-reached');
const mixedLengthClauses = logical('or', [
  atom({ id: 'L9', path: ['items'], accessor: 'length', operator: '===', value: 0, pathTypeHint: { kind: 'array' } }),
  lengthBeyondCap,
]);
const mixedLengthResult = solver.solveAll(createConstraintIR(mixedLengthClauses), { maxSolutions: 10 });
assert.equal(mixedLengthResult.status, 'solved');
assert.equal(mixedLengthResult.complete, false);
assert.equal(mixedLengthResult.truncated, true);
assert.ok(mixedLengthResult.solutions.some(value => value.items.length === 0));

const countVsLength = atom({ id: 'L6', path: ['input', 'count'], pathTypeHint: { kind: 'number' },
  operator: '<', valuePath: ['input', 'items'], valueAccessor: 'length',
  valuePathTypeHint: { kind: 'array' } });
const countVsLengthSolved = solver.solve(createConstraintIR(countVsLength));
assert.equal(countVsLengthSolved.status, 'solved');
assert.ok(countVsLengthSolved.assignments.input.count < countVsLengthSolved.assignments.input.items.length);
assert.equal(solver.solve(createConstraintIR(countVsLength), { desired: false }).status, 'solved');

const stringRelational = atom({ id: 'S1', path: ['name'], operator: '<', value: 'M' });
assert.equal(solver.solve(createConstraintIR(stringRelational)).status, 'unsupported');

const conflictingTypedHint = atom({ id: 'T0', path: ['age'], operator: '>', value: 18, pathType: 'string' });
assert.equal(solver.solve(createConstraintIR(conflictingTypedHint), { pathTypes: { age: 'number' } }).status, 'unsupported');
const samePathConflict = logical('and', [
  atom({ id: 'TC1', path: ['input', 'value'], operator: 'truthy', pathType: 'string' }),
  atom({ id: 'TC2', path: ['input', 'value'], operator: 'truthy', pathType: 'number' }),
]);
assert.equal(solver.solve(createConstraintIR(samePathConflict)).status, 'unsupported');

const typedRelational = atom({ id: 'T1', path: ['name'], operator: '>', value: 18, pathType: 'string' });
assert.equal(solver.solve(createConstraintIR(typedRelational)).status, 'unsupported');

const malformedOperator = { kind: 'atom', id: 'BAD1', path: ['x'], operator: 'approximately', value: 1 };
assert.equal(validateConstraintExpr(malformedOperator).valid, false);
assert.equal(solver.solve(createConstraintIR(atom({ id: 'SEED', path: ['x'], operator: 'truthy' })), { seed: new Date() }).status, 'unsupported');
assert.equal(solver.solve(createConstraintIR(atom({ id: 'SEED2', path: ['x'], operator: 'truthy' })), { seed: { x: undefined } }).status, 'unsupported');
assert.equal(solver.solve(malformedOperator).status, 'unsupported');

const malformedSource = atom({ id: 'BAD2', path: ['x'], operator: '===', value: 1, source: { start: 10, end: 2 } });
assert.equal(validateConstraintExpr(malformedSource).valid, false);

const duplicateIds = logical('and', [
  atom({ id: 'DUP', path: ['x'], operator: '===', value: 1 }),
  atom({ id: 'DUP', path: ['y'], operator: '===', value: 1 }),
]);
assert.equal(validateConstraintExpr(duplicateIds).valid, false);

const unsafePath = atom({ id: 'BAD3', path: ['__proto__', 'polluted'], operator: 'truthy' });
assert.equal(validateConstraintExpr(unsafePath).valid, false);

const wrongAtomIndex = { ...ir, atoms: [ir.atoms[1], ir.atoms[0]] };
assert.equal(validateConstraintIR(wrongAtomIndex).valid, false);

const limited = solver.solve(ir, { maxCandidates: 1, seed: { passenger: { age: 17, active: false } } });
assert.equal(limited.status, 'limit-reached');
assert.equal(limited.attempts, 1);
assert.equal(solver.solve(constant(true)).status, 'solved');
assert.equal(solver.solve(constant(false), { desired: true }).status, 'unsatisfiable');
const extremeEquality = atom({ id: 'MAX1', path: ['x'], operator: '!==', value: Number.MAX_VALUE });
const extremeSolved = solver.solve(createConstraintIR(extremeEquality));
assert.equal(extremeSolved.status, 'solved');
assert.notEqual(extremeSolved.assignments.x, Number.MAX_VALUE);
assert.equal(solver.solve(age, { maxCandidates: 0 }).status, 'unsupported');
assert.equal(solver.solve(age, { seed: [] }).status, 'unsupported');


// Multi-result search preserves disjoint short-circuit witnesses.
const multiAnd = logical('and', [
  atom({ id: 'MA', path: ['a'], operator: 'truthy', pathType: 'boolean' }),
  atom({ id: 'MB', path: ['b'], operator: 'truthy', pathType: 'boolean' }),
]);
const falseAndAll = solver.solveAll(createConstraintIR(multiAnd), { desired: false, maxSolutions: 20 });
assert.equal(falseAndAll.status, 'solved');
assert.ok(falseAndAll.solutions.length >= 2, 'false AND must expose both short-circuit witnesses');
assert.ok(falseAndAll.solutions.every(value => evaluateConstraint(multiAnd, value) === false));
assert.ok(falseAndAll.solutions.some(value => value.a === false && !Object.hasOwn(value, 'b')));
assert.ok(falseAndAll.solutions.some(value => value.a === true && value.b === false));
assert.ok(falseAndAll.solutionPaths.some(paths => paths.length === 1 && JSON.stringify(paths[0]) === JSON.stringify(['a'])));
assert.ok(falseAndAll.solutionPaths.some(paths => paths.length === 2));

const multiOr = logical('or', [
  atom({ id: 'MOA', path: ['a'], operator: 'truthy', pathType: 'boolean' }),
  atom({ id: 'MOB', path: ['b'], operator: 'truthy', pathType: 'boolean' }),
]);
const trueOrAll = solver.solveAll(createConstraintIR(multiOr), { desired: true, maxSolutions: 20 });
assert.equal(trueOrAll.status, 'solved');
assert.ok(trueOrAll.solutions.length >= 2, 'true OR must expose both short-circuit witnesses');
assert.ok(trueOrAll.solutions.every(value => evaluateConstraint(multiOr, value) === true));
assert.ok(trueOrAll.solutions.some(value => value.a === true && !Object.hasOwn(value, 'b')));
assert.ok(trueOrAll.solutions.some(value => value.a === false && value.b === true));
assert.ok(trueOrAll.solutionPaths.every(paths => paths.length >= 1));

// Literal-union hints preserve TypeScript's finite domain rather than
// inventing strings that cannot be assigned to the declared property.
const roleUnion = logical('or', [
  atom({ id: 'RU1', path: ['role'], operator: '===', value: 'admin', pathTypeHint: { kind: 'string', allowedValues: ['admin', 'owner', 'user'] } }),
  atom({ id: 'RU2', path: ['role'], operator: '===', value: 'owner', pathTypeHint: { kind: 'string', allowedValues: ['admin', 'owner', 'user'] } }),
]);
const roleUnionTrue = solver.solveAll(createConstraintIR(roleUnion), { desired: true, solutionsPerClause: 1 });
assert.equal(roleUnionTrue.status, 'solved');
assert.deepEqual(roleUnionTrue.solutions.map(item => item.role), ['admin', 'owner']);
const roleUnionFalse = solver.solveAll(createConstraintIR(roleUnion), { desired: false, solutionsPerClause: 1 });
assert.equal(roleUnionFalse.status, 'solved');
assert.equal(roleUnionFalse.solutions[0].role, 'user');

// Same-path numeric atoms are intersected before combinations are explored.
const numericIntersection = logical('and', [
  atom({ id: 'NI1', path: ['age'], operator: '>', value: 18, pathType: 'number' }),
  atom({ id: 'NI2', path: ['age'], operator: '<', value: 20, pathType: 'number' }),
]);
const intersectionAll = solver.solveAll(createConstraintIR(numericIntersection), { maxSolutions: 20 });
assert.equal(intersectionAll.status, 'solved');
assert.ok(intersectionAll.solutions.length >= 1);
assert.ok(intersectionAll.solutions.every(value => value.age > 18 && value.age < 20));
assert.ok(intersectionAll.solutions.some(value => value.age === 19));
assert.deepEqual(intersectionAll.domainIntersections[0], {
  path: ['age'], kind: 'numeric-interval',
  lower: { value: 18, inclusive: false },
  upper: { value: 20, inclusive: false },
});

const incompatibleIntersection = logical('and', [
  atom({ id: 'NX1', path: ['age'], operator: '>', value: 20, pathType: 'number' }),
  atom({ id: 'NX2', path: ['age'], operator: '<', value: 18, pathType: 'number' }),
]);
const incompatibleDomain = solver.solveAll(createConstraintIR(incompatibleIntersection), { maxSolutions: 20 });
assert.equal(incompatibleDomain.status, 'unsatisfiable');
assert.equal(incompatibleDomain.domainIntersections[0].impossible, true);

// Equality literals must be available even when an atom has the opposite
// polarity from the overall short-circuit decision.
const equalityOr = logical('or', [
  atom({ id: 'EQ1', path: ['kind'], operator: '!==', value: 'blocked', pathType: 'string' }),
  atom({ id: 'EQ2', path: ['status'], operator: '===', value: 'ready', pathType: 'string' }),
]);
const equalityOrSolutions = solver.solveAll(createConstraintIR(equalityOr), { desired: true, maxSolutions: 20 });
assert.equal(equalityOrSolutions.status, 'solved');
assert.ok(equalityOrSolutions.solutions.some(value => value.kind === 'blocked' && value.status === 'ready'));


const numericEqualityConflict = logical('and', [
  atom({ id: 'NE1', path: ['age'], operator: '===', value: 19, pathType: 'number' }),
  atom({ id: 'NE2', path: ['age'], operator: '!==', value: 19, pathType: 'number' }),
]);
const numericEqualityConflictResult = solver.solveAll(createConstraintIR(numericEqualityConflict), { maxSolutions: 20 });
assert.equal(numericEqualityConflictResult.status, 'unsatisfiable');
assert.equal(numericEqualityConflictResult.domainIntersections[0].impossible, true);

const nestedShortCircuit = logical('and', [
  atom({ id: 'NS1', path: ['enabled'], operator: 'truthy', pathType: 'boolean' }),
  logical('or', [
    atom({ id: 'NS2', path: ['mode'], operator: '===', value: 'fast', pathType: 'string' }),
    atom({ id: 'NS3', path: ['fallback'], operator: 'truthy', pathType: 'boolean' }),
  ]),
]);
const nestedShortCircuitFalse = solver.solveAll(createConstraintIR(nestedShortCircuit), { desired: false, maxSolutions: 20 });
assert.equal(nestedShortCircuitFalse.status, 'solved');
assert.ok(nestedShortCircuitFalse.solutions.every(value => evaluateConstraint(nestedShortCircuit, value) === false));

const oneWitnessPerClause = solver.solveAll(createConstraintIR(multiOr), {
  desired: true, maxSolutions: 20, solutionsPerClause: 1,
});
assert.equal(oneWitnessPerClause.status, 'solved');
assert.equal(oneWitnessPerClause.solutions.length, 2, 'one-per-clause mode must preserve both OR witnesses');
assert.equal(oneWitnessPerClause.complete, true, 'intentional per-clause sampling is complete when every clause has a witness');
assert.ok(oneWitnessPerClause.solutions.every(value => evaluateConstraint(multiOr, value) === true));

const boundedMulti = solver.solveAll(createConstraintIR(multiOr), { desired: true, maxSolutions: 1, solutionsPerClause: 1 });
assert.equal(boundedMulti.status, 'solved');
assert.equal(boundedMulti.solutions.length, 1);
assert.equal(boundedMulti.complete, false, 'result cap must be visible as incomplete enumeration');
assert.equal(solver.solveAll(createConstraintIR(multiOr), { solutionsPerClause: 0 }).status, 'unsupported');
const dnfLimit = solver.solveAll(createConstraintIR(multiOr), { desired: true, maxBranches: 1 });
assert.equal(dnfLimit.status, 'limit-reached');

console.log('Constraint IR / Solver unit tests passed.');
