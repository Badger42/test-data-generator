import {
  isConstraintUndefined,
  collectConstraintPaths,
  validateConstraintExpr,
  validateConstraintIR,
} from '../constraints/constraint-ir.mjs';

const UNSET = Symbol('constraint-unset');
const SERIALIZED_UNDEFINED = Object.freeze({ $undefined: true });
const isSerializedUndefined = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === 1 && value.$undefined === true);
const RELATIONAL = new Set(['<', '<=', '>', '>=']);
const EQUALITY = new Set(['==', '===', '!=', '!==']);
const MAX_MATERIALIZED_LENGTH = 8;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pathKey = path => JSON.stringify(path);
const isObject = value => value !== null && typeof value === 'object';

function resolveLiteral(value) {
  return isConstraintUndefined(value) ? undefined : value;
}

function readPath(root, path, accessor = 'value') {
  let value = root;
  for (const segment of path) {
    if (isSerializedUndefined(value) || value === null || value === undefined) {
      throw new TypeError(`Cannot read ${segment} through null/undefined path ${path.join('.')}.`);
    }
    value = value[segment];
  }
  if (isSerializedUndefined(value)) value = undefined;
  if (accessor === 'length') {
    if (value === null || value === undefined) {
      throw new TypeError(`Cannot read length through null/undefined path ${path.join('.')}.`);
    }
    return value.length;
  }
  return value;
}

function evaluateValueExpression(expression, values) {
  if (!expression || typeof expression !== 'object') throw new TypeError('Missing value expression.');
  if (expression.kind === 'literal') return resolveLiteral(expression.value);
  if (expression.kind === 'path') return readPath(values, expression.path, expression.accessor ?? 'value');
  if (expression.kind === 'unary') {
    const operand = evaluateValueExpression(expression.operand, values);
    if (typeof operand !== 'number') throw new TypeError('Arithmetic unary operands must be numbers.');
    return expression.operator === '-' ? -operand : +operand;
  }
  if (expression.kind === 'binary') {
    const left = evaluateValueExpression(expression.left, values);
    const right = evaluateValueExpression(expression.right, values);
    if (typeof left !== 'number' || typeof right !== 'number') throw new TypeError('Arithmetic operands must be numbers.');
    switch (expression.operator) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '%': return left % right;
      case '**': return left ** right;
      default: throw new TypeError(`Unsupported arithmetic operator: ${expression.operator}`);
    }
  }
  throw new TypeError(`Unknown value expression node: ${expression.kind}`);
}

function expressionPaths(expression, output = []) {
  if (!expression || typeof expression !== 'object') return output;
  if (expression.kind === 'path') output.push({
    path: expression.path,
    accessor: expression.accessor ?? 'value',
    pathTypeHint: expression.pathTypeHint,
  });
  else if (expression.kind === 'unary') expressionPaths(expression.operand, output);
  else if (expression.kind === 'binary') {
    expressionPaths(expression.left, output);
    expressionPaths(expression.right, output);
  }
  return output;
}

function expressionNumericLiterals(expression, output = []) {
  if (!expression || typeof expression !== 'object') return output;
  if (expression.kind === 'literal' && typeof expression.value === 'number' && Number.isFinite(expression.value)) output.push(expression.value);
  else if (expression.kind === 'unary') expressionNumericLiterals(expression.operand, output);
  else if (expression.kind === 'binary') {
    expressionNumericLiterals(expression.left, output);
    expressionNumericLiterals(expression.right, output);
  }
  return output;
}

function atomExpressionPaths(atomNode) {
  if (atomNode.leftExpression) {
    return [...expressionPaths(atomNode.leftExpression), ...expressionPaths(atomNode.rightExpression)];
  }
  return [
    { path: atomNode.path, accessor: atomNode.accessor ?? 'value', pathTypeHint: atomNode.pathTypeHint },
    ...(atomNode.valuePath ? [{ path: atomNode.valuePath, accessor: atomNode.valueAccessor ?? 'value', pathTypeHint: atomNode.valuePathTypeHint }] : []),
  ];
}

function isArithmeticExpression(expression) {
  if (!expression || typeof expression !== 'object') return false;
  if (expression.kind === 'binary') return true;
  if (expression.kind === 'unary') return isArithmeticExpression(expression.operand);
  return false;
}

function expressionCandidateValues(atoms) {
  const literals = atoms.flatMap(item => [
    ...expressionNumericLiterals(item.leftExpression),
    ...expressionNumericLiterals(item.rightExpression),
  ]);
  const output = [-10, -2, -1, 0, 1, 2, 5, 10, 20, 50, 100];
  const add = value => { if (Number.isFinite(value) && !output.includes(value)) output.push(value); };
  const collectModuloDivisors = expression => {
    if (!expression || typeof expression !== 'object') return [];
    if (expression.kind === 'binary') {
      const own = expression.operator === '%' && expression.right?.kind === 'literal' &&
        typeof expression.right.value === 'number' && Number.isInteger(expression.right.value) && expression.right.value !== 0
        ? [Math.abs(expression.right.value)] : [];
      return [...own, ...collectModuloDivisors(expression.left), ...collectModuloDivisors(expression.right)];
    }
    if (expression.kind === 'unary') return collectModuloDivisors(expression.operand);
    return [];
  };
  for (const item of atoms) {
    for (const divisor of collectModuloDivisors(item.leftExpression)) {
      if (divisor > 0 && divisor <= 100) {
        for (let multiple = -8; multiple <= 8; multiple += 1) add(divisor * multiple);
      }
    }
  }
  for (const value of literals) {
    add(value); add(value - 1); add(value + 1);
    add(-value); add(value * 2); add(value / 2);
    for (const factor of literals) {
      if (factor === 0) continue;
      add(value - factor); add(value + factor);
      add(value * factor); add(value / factor);
    }
  }
  return output;
}

function affineValueExpression(expression) {
  if (!expression || typeof expression !== 'object') return null;
  if (expression.kind === 'literal') return typeof expression.value === 'number' ? { path: null, coefficient: 0, offset: expression.value } : null;
  if (expression.kind === 'path') {
    if (expression.accessor === 'length') return null;
    return { path: [...expression.path], coefficient: 1, offset: 0 };
  }
  if (expression.kind === 'unary') {
    const value = affineValueExpression(expression.operand);
    if (!value) return null;
    const sign = expression.operator === '-' ? -1 : 1;
    return { ...value, coefficient: value.coefficient * sign, offset: value.offset * sign };
  }
  if (expression.kind !== 'binary') return null;
  const left = affineValueExpression(expression.left);
  const right = affineValueExpression(expression.right);
  if (!left || !right) return null;
  const samePath = left.path && right.path && pathKey(left.path) === pathKey(right.path);
  const onePath = left.path && !right.path ? left.path : (!left.path && right.path ? right.path : null);
  if (expression.operator === '+' || expression.operator === '-') {
    if (left.path && right.path && !samePath) return null;
    const sign = expression.operator === '-' ? -1 : 1;
    return {
      path: left.path ?? right.path,
      coefficient: left.coefficient + sign * right.coefficient,
      offset: left.offset + sign * right.offset,
    };
  }
  if (expression.operator === '*') {
    if (left.path && right.path) return null;
    const factor = left.path ? right.offset : left.offset;
    const source = left.path ? left : right;
    return { path: onePath, coefficient: source.coefficient * factor, offset: source.offset * factor };
  }
  if (expression.operator === '/' && right.path === null && right.offset !== 0) {
    return { path: left.path, coefficient: left.coefficient / right.offset, offset: left.offset / right.offset };
  }
  return null;
}

function arithmeticBoundaryCandidates(atoms, path) {
  const values = [];
  const add = value => {
    if (Number.isFinite(value) && !values.includes(value)) values.push(value);
  };
  for (const item of atoms) {
    const left = affineValueExpression(item.leftExpression);
    const right = affineValueExpression(item.rightExpression);
    if (!left || !right || !left.path && !right.path) continue;
    if (left.path && right.path && pathKey(left.path) !== pathKey(right.path)) continue;
    const sourcePath = left.path ?? right.path;
    if (pathKey(sourcePath) !== pathKey(path)) continue;
    const coefficient = left.coefficient - right.coefficient;
    const offset = left.offset - right.offset;
    if (coefficient === 0) continue;
    const boundary = -offset / coefficient;
    add(boundary);
    add(boundary - 1); add(boundary + 1);
    add(nextFloat(boundary, -1)); add(nextFloat(boundary, 1));
  }
  return values;
}

function compare(left, operator, right) {
  switch (operator) {
    // Deliberately preserve JavaScript loose-equality semantics from source code.
    // eslint-disable-next-line eqeqeq
    case '==': return left == right;
    case '===': return left === right;
    // eslint-disable-next-line eqeqeq
    case '!=': return left != right;
    case '!==': return left !== right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    case 'truthy': return Boolean(left);
    default: throw new TypeError(`Unsupported constraint operator: ${operator}`);
  }
}

/** Evaluate IR using JavaScript truthiness, comparison and short-circuit rules. */
export function evaluateConstraint(expr, values) {
  if (expr.kind === 'constant') return expr.value;
  if (expr.kind === 'not') return !evaluateConstraint(expr.operand, values);
  if (expr.kind === 'logical') {
    if (expr.operator === 'and') {
      for (const child of expr.operands) if (!evaluateConstraint(child, values)) return false;
      return true;
    }
    if (expr.operator === 'or') {
      for (const child of expr.operands) if (evaluateConstraint(child, values)) return true;
      return false;
    }
    throw new TypeError(`Unsupported logical operator: ${expr.operator}`);
  }
  if (expr.kind === 'atom') {
    const left = expr.leftExpression
      ? evaluateValueExpression(expr.leftExpression, values)
      : readPath(values, expr.path, expr.accessor ?? 'value');
    const right = expr.rightExpression
      ? evaluateValueExpression(expr.rightExpression, values)
      : expr.valuePath
        ? readPath(values, expr.valuePath, expr.valueAccessor ?? 'value')
        : resolveLiteral(expr.value);
    return compare(left, expr.operator, right);
  }
  throw new TypeError(`Unknown Constraint IR node: ${expr.kind}`);
}

function cloneJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, { value: cloneJson(item), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function getPathOrUnset(root, path) {
  let value = root;
  for (let index = 0; index < path.length; index += 1) {
    if (value === null || value === undefined || !own(Object(value), path[index])) return UNSET;
    value = value[path[index]];
  }
  return value === undefined || isSerializedUndefined(value) ? UNSET : value;
}

function setPath(root, path, value, constrainedPaths) {
  if (!path.length) return;
  let target = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const nextPath = path.slice(0, index + 1);
    const current = target[key];
    if (!isObject(current)) {
      // A separately constrained parent must retain its chosen primitive value.
      if (constrainedPaths.has(pathKey(nextPath))) return;
      Object.defineProperty(target, key, {
        value: {}, enumerable: true, writable: true, configurable: true,
      });
    }
    target = target[key];
  }
  const leaf = path[path.length - 1];
  if (value === UNSET) {
    if (path.length === 1) {
      Object.defineProperty(target, leaf, {
        value: SERIALIZED_UNDEFINED, enumerable: true, writable: true, configurable: true,
      });
    } else {
      delete target[leaf];
    }
  } else Object.defineProperty(target, leaf, {
    value: cloneJson(value), enumerable: true, writable: true, configurable: true,
  });
}

function stableValueKey(value) {
  if (value === UNSET) return 'UNSET';
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return `object:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
}

function addUnique(output, value) {
  const key = stableValueKey(value);
  if (!output.some(item => stableValueKey(item) === key)) output.push(value);
}

function differentRepresentative(value, operator) {
  if (isConstraintUndefined(value)) return operator === '==' ? 0 : null;
  if (value === null) return operator === '==' ? 0 : UNSET;
  if (typeof value === 'number') {
    const direction = value >= 0 ? 1 : -1;
    const first = nextFloat(value, direction);
    if (Number.isFinite(first) && first !== value) return first;
    const second = nextFloat(value, -direction);
    return Number.isFinite(second) && second !== value ? second : UNSET;
  }
  if (typeof value === 'string') return `${value}_other`;
  if (typeof value === 'boolean') return !value;
  return UNSET;
}

function nextFloat(value, direction) {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  const increment = (value > 0) === (direction > 0);
  bits = increment ? bits + 1n : bits - 1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

/** One representative from each interval induced by finite numeric thresholds. */
function numericPartition(values) {
  const thresholds = [...new Set(values)].sort((a, b) => a - b);
  if (!thresholds.length) return [-1, 0, 1];
  const output = [];
  for (const value of thresholds) addUnique(output, value);

  // Every open interval between adjacent thresholds gets one readable
  // representative; fall back to the next IEEE-754 value for adjacent floats.
  for (let index = 0; index < thresholds.length - 1; index += 1) {
    const left = thresholds[index];
    const right = thresholds[index + 1];
    const midpoint = left / 2 + right / 2;
    if (Number.isFinite(midpoint) && midpoint > left && midpoint < right) addUnique(output, midpoint);
    else {
      const adjacent = nextFloat(left, 1);
      if (Number.isFinite(adjacent) && adjacent < right) addUnique(output, adjacent);
    }
  }

  const min = thresholds[0];
  const max = thresholds[thresholds.length - 1];
  const below = min - Math.max(1, Math.abs(min) * 0.1);
  const above = max + Math.max(1, Math.abs(max) * 0.1);
  if (Number.isFinite(below) && below < min) addUnique(output, below);
  else {
    const adjacent = nextFloat(min, -1);
    if (Number.isFinite(adjacent)) addUnique(output, adjacent);
  }
  if (Number.isFinite(above) && above > max) addUnique(output, above);
  else {
    const adjacent = nextFloat(max, 1);
    if (Number.isFinite(adjacent)) addUnique(output, adjacent);
  }
  return output;
}

function preflight(expr, pathTypes = {}) {
  const unsupported = [];
  const atoms = [];
  const visit = node => {
    if (node.kind === 'atom') atoms.push(node);
    else if (node.kind === 'logical') node.operands.forEach(visit);
    else if (node.kind === 'not') visit(node.operand);
  };
  visit(expr);

  const collectionKind = hint => hint.kind === 'array' || hint.kind === 'string';
  const operandKind = (hint, accessor) => accessor === 'length' ? 'number' : hint.kind;
  for (const item of atoms) {
    if (item.operator === 'unsupported') {
      unsupported.push({ id: item.id, reason: item.unsupportedReason ?? 'Unsupported source expression.' });
      continue;
    }
    if (item.leftExpression) {
      const refs = atomExpressionPaths(item);
      if (!refs.length) {
        unsupported.push({ id: item.id, reason: 'Arithmetic expression has no symbolic input paths.' });
        continue;
      }
      let invalid = null;
      const checkValue = valueExpr => {
        if (!valueExpr || invalid) return;
        if (valueExpr.kind === 'literal') {
          if (typeof valueExpr.value !== 'number' || !Number.isFinite(valueExpr.value)) invalid = 'Arithmetic expressions currently require finite numeric literals.';
        } else if (valueExpr.kind === 'path') {
          const hint = resolvePathHint(valueExpr.path, 'unknown', valueExpr.pathTypeHint, pathTypes);
          const kind = valueExpr.accessor === 'length' ? 'number' : hint.kind;
          if (hint.kind === 'conflict' || !['number', 'unknown'].includes(kind)) invalid = `Arithmetic expression path ${valueExpr.path.join('.')} is not numeric (${kind}).`;
        } else if (valueExpr.kind === 'unary') checkValue(valueExpr.operand);
        else if (valueExpr.kind === 'binary') { checkValue(valueExpr.left); checkValue(valueExpr.right); }
        else invalid = `Unsupported arithmetic value expression kind ${String(valueExpr.kind)}.`;
      };
      checkValue(item.leftExpression);
      if (item.rightExpression) checkValue(item.rightExpression);
      if (item.operator !== 'truthy' && !item.rightExpression) invalid = 'Arithmetic comparison is missing its right-hand expression.';
      if (!['truthy', ...RELATIONAL, ...EQUALITY].includes(item.operator)) invalid = `Unsupported arithmetic comparison operator ${item.operator}.`;
      if (invalid) unsupported.push({ id: item.id, reason: invalid });
      continue;
    }
    const leftHint = resolvePathHint(item.path, item.pathType, item.pathTypeHint, pathTypes);
    const rightHint = item.valuePath
      ? resolvePathHint(item.valuePath, 'unknown', item.valuePathTypeHint, pathTypes)
      : null;
    if (leftHint.kind === 'conflict' || rightHint?.kind === 'conflict') {
      unsupported.push({ id: item.id, reason: `Conflicting type hints for path ${item.path.join('.')}${item.valuePath ? ` or ${item.valuePath.join('.')}` : ''}.` });
      continue;
    }

    if (item.accessor === 'length' && !collectionKind(leftHint)) {
      unsupported.push({ id: item.id, reason: `Length accessor requires a string/array path type; got ${leftHint.kind}.` });
      continue;
    }
    if (item.valuePath && item.valueAccessor === 'length' && !collectionKind(rightHint)) {
      unsupported.push({ id: item.id, reason: `Right-hand length accessor requires a string/array path type; got ${rightHint.kind}.` });
      continue;
    }

    const leftKind = operandKind(leftHint, item.accessor ?? 'value');
    const rightKind = item.valuePath
      ? operandKind(rightHint, item.valueAccessor ?? 'value')
      : (item.value === null ? 'null' : isConstraintUndefined(item.value) ? 'undefined' : typeof item.value);

    if (item.valuePath) {
      if (item.operator === 'truthy') {
        unsupported.push({ id: item.id, reason: 'A path-to-path truthiness atom is not a comparison and cannot be represented by the current compiler.' });
      } else if (RELATIONAL.has(item.operator) && (leftKind !== 'number' || rightKind !== 'number')) {
        unsupported.push({ id: item.id, reason: 'Path-to-path relational comparisons currently require numeric paths or numeric length accessors on typed collections.' });
      } else if (EQUALITY.has(item.operator) && (!['string', 'number', 'boolean'].includes(leftKind) || leftKind !== rightKind)) {
        unsupported.push({ id: item.id, reason: 'Path-to-path equality currently requires matching known primitive operand types (string, number or boolean).' });
      } else if (!RELATIONAL.has(item.operator) && !EQUALITY.has(item.operator)) {
        unsupported.push({ id: item.id, reason: `Operator ${item.operator} is not supported for path-to-path comparisons.` });
      }
      continue;
    }

    if (item.accessor === 'length') {
      if (!RELATIONAL.has(item.operator) && !EQUALITY.has(item.operator)) {
        unsupported.push({ id: item.id, reason: 'Length comparisons require a supported comparison operator.' });
      } else if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
        unsupported.push({ id: item.id, reason: 'Length comparisons currently require a finite numeric literal.' });
      } else if (item.value > MAX_MATERIALIZED_LENGTH || (item.operator === '>' && item.value >= MAX_MATERIALIZED_LENGTH)) {
        unsupported.push({ id: item.id, reason: `Length condition may require materialization beyond the current limit ${MAX_MATERIALIZED_LENGTH}.` });
      }
      continue;
    }

    if (RELATIONAL.has(item.operator) && typeof item.value !== 'number') {
      unsupported.push({ id: item.id, reason: 'The bounded solver currently supports relational comparisons only against numeric literals.' });
    } else if (RELATIONAL.has(item.operator) && leftHint.kind !== 'unknown' && leftHint.kind !== 'number') {
      unsupported.push({ id: item.id, reason: `Relational numeric comparison conflicts with path type ${leftHint.kind}.` });
    } else if ((item.operator === '==' || item.operator === '!=') && leftHint.kind !== 'unknown' &&
        item.value !== null && !isConstraintUndefined(item.value) && !matchesPathKind(item.value, leftHint)) {
      unsupported.push({ id: item.id, reason: `Loose equality coercion against path type ${leftHint.kind} is not materialized by the current solver.` });
    }
    if (!RELATIONAL.has(item.operator) && !EQUALITY.has(item.operator) && item.operator !== 'truthy') {
      unsupported.push({ id: item.id, reason: `Operator ${item.operator} is not supported by the solver.` });
    }
  }
  return { atoms, unsupported };
}

function normalizePathHint(hint) {
  if (typeof hint === 'string') return { kind: hint, optional: false, nullable: false, allowedValues: null };
  return {
    kind: hint.kind ?? hint.type ?? 'unknown',
    optional: hint.optional === true,
    nullable: hint.nullable === true,
    allowedValues: Array.isArray(hint.allowedValues) ? [...hint.allowedValues] : null,
  };
}

function resolvePathHint(path, atomPathType, atomPathTypeHint, pathTypes) {
  const external = pathTypes?.[pathKey(path)] ?? pathTypes?.[path.join('.')];
  const embedded = normalizePathHint(atomPathTypeHint ?? atomPathType ?? 'unknown');
  if (external === undefined) return embedded;
  const supplied = normalizePathHint(external);
  if (embedded.kind !== 'unknown' && supplied.kind !== 'unknown' && embedded.kind !== supplied.kind) {
    return { kind: 'conflict', optional: embedded.optional || supplied.optional, nullable: embedded.nullable || supplied.nullable };
  }
  let allowedValues = supplied.allowedValues ?? embedded.allowedValues;
  if (supplied.allowedValues && embedded.allowedValues) {
    allowedValues = supplied.allowedValues.filter(value => embedded.allowedValues.some(item => Object.is(item, value)));
  }
  return {
    kind: supplied.kind === 'unknown' ? embedded.kind : supplied.kind,
    optional: embedded.optional || supplied.optional,
    nullable: embedded.nullable || supplied.nullable,
    allowedValues,
  };
}

function matchesPathKind(value, hint) {
  if (isConstraintUndefined(value)) return hint.optional || hint.kind === 'unknown';
  if (value === null) return hint.nullable || hint.kind === 'unknown';
  if (hint.kind === 'unknown') return true;
  if (hint.kind === 'array') return Array.isArray(value);
  if (hint.kind === 'object') return isObject(value) && !Array.isArray(value);
  return typeof value === hint.kind;
}

function isCompatibleLiteral(value, hint) {
  if (!matchesPathKind(value, hint)) return false;
  if (hint.allowedValues && value !== null && !isConstraintUndefined(value)) {
    return hint.allowedValues.some(item => Object.is(item, value));
  }
  return true;
}

function typeRepresentatives(hint, desired) {
  let values;
  if (hint.allowedValues) values = [...hint.allowedValues];
  else switch (hint.kind) {
    case 'number': values = [0, 1, -1]; break;
    case 'string': values = ['', 'test']; break;
    case 'boolean': values = [false, true]; break;
    case 'array': values = [[], [null]]; break;
    case 'object': values = [{}]; break;
    default: values = [true, false, 1, 0, 'x', '', {}, null, UNSET]; break;
  }
  // Match the established truthiness representative preference: when a path can
  // be absent, use undefined before null for falsy object outcomes.
  if (hint.optional) values.push(UNSET);
  if (hint.nullable) values.push(null);
  return values;
}

function preferredNumericRepresentatives(atoms, desired) {
  const values = [];
  const add = value => {
    if (Number.isFinite(value) && !values.includes(value)) values.push(value);
  };
  for (const item of atoms) {
    if (!RELATIONAL.has(item.operator) && !EQUALITY.has(item.operator)) continue;
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) continue;
    const op = desired ? item.operator : ({
      '<': '>=', '<=': '>', '>': '<=', '>=': '<',
      '===': '!==', '==': '!=', '!==': '===', '!=': '==',
    })[item.operator];
    const value = item.value;
    if (op === '<') add(Math.ceil(value) - 1);
    else if (op === '<=') add(Math.floor(value));
    else if (op === '>') add(Math.floor(value) + 1);
    else if (op === '>=') add(value);
    else if (op === '===' || op === '==') add(value);
    else if (op === '!==' || op === '!=') { add(value + 1); add(value - 1); }
  }
  return values;
}

function preferredEqualityRepresentatives(atoms, desired, hint) {
  const values = [];
  const add = value => {
    if (isCompatibleLiteral(value, hint)) addUnique(values, value === undefined ? UNSET : value);
  };
  for (const item of atoms) {
    if (!EQUALITY.has(item.operator)) continue;
    const operator = desired ? item.operator : ({
      '===': '!==', '==': '!=', '!==': '===', '!=': '==',
    })[item.operator];
    if (operator === '===' || operator === '==') add(resolveLiteral(item.value));
    else add(differentRepresentative(item.value, operator));
  }
  return values;
}

function lengthCandidates(entry) {
  const lengths = [0, 1, 2];
  const add = value => {
    if (Number.isInteger(value) && value >= 0 && value <= MAX_MATERIALIZED_LENGTH && !lengths.includes(value)) lengths.push(value);
  };
  for (const item of entry.leftAtoms) {
    if (item.accessor !== 'length' || typeof item.value !== 'number') continue;
    const threshold = item.value;
    add(Math.floor(threshold));
    add(Math.ceil(threshold));
    add(Math.floor(threshold) - 1);
    add(Math.ceil(threshold) + 1);
  }
  return lengths.sort((a, b) => a - b).map(length =>
    entry.hint.kind === 'string' ? 'x'.repeat(length) : Array.from({ length }, () => null));
}

function preferCandidateMetric(variable, preferred) {
  const index = variable.values.findIndex(value => {
    if (variable.accessors.has('length')) return value !== null && value !== undefined && value.length === preferred;
    return value === preferred;
  });
  if (index > 0) variable.values.unshift(variable.values.splice(index, 1)[0]);
}

function prioritizeRelationalPairRepresentatives(variables, clause) {
  const byPath = new Map(variables.map(variable => [pathKey(variable.path), variable]));
  for (const item of clause) {
    const atomNode = item.atom;
    if (!atomNode.valuePath || !RELATIONAL.has(atomNode.operator)) continue;
    const left = byPath.get(pathKey(atomNode.path));
    const right = byPath.get(pathKey(atomNode.valuePath));
    if (!left || !right) continue;

    let preferred;
    switch (atomNode.operator) {
      case '<': preferred = item.desired ? [0, 1] : [1, 0]; break;
      case '<=': preferred = item.desired ? [0, 0] : [1, 0]; break;
      case '>': preferred = item.desired ? [1, 0] : [0, 1]; break;
      case '>=': preferred = item.desired ? [0, 0] : [0, 1]; break;
      default: continue;
    }
    preferCandidateMetric(left, preferred[0]);
    preferCandidateMetric(right, preferred[1]);
  }
}

function allowedRelationCategories(operator, desired) {
  switch (operator) {
    case '<': return desired ? ['less'] : ['greater', 'equal'];
    case '<=': return desired ? ['less', 'equal'] : ['greater'];
    case '>': return desired ? ['greater'] : ['less', 'equal'];
    case '>=': return desired ? ['greater', 'equal'] : ['less'];
    default: return [];
  }
}

function relationCategory(atomNode, assignments) {
  const left = readPath(assignments, atomNode.path, atomNode.accessor ?? 'value');
  const right = readPath(assignments, atomNode.valuePath, atomNode.valueAccessor ?? 'value');
  if (left < right) return 'less';
  if (left > right) return 'greater';
  if (left === right) return 'equal';
  return 'other';
}

function buildDomains(atoms, seed, pathTypes, desired) {
  const byPath = new Map();
  const ensure = (path, hint) => {
    const key = pathKey(path);
    if (!byPath.has(key)) byPath.set(key, { path: [...path], leftAtoms: [], rightAtoms: [], values: [], hint: null, accessors: new Set() });
    const entry = byPath.get(key);
    if (hint) {
      if (!entry.hint) entry.hint = { ...hint };
      else {
        if (entry.hint.kind !== 'unknown' && hint.kind !== 'unknown' && entry.hint.kind !== hint.kind) entry.typeConflict = true;
        else if (entry.hint.kind === 'unknown' && hint.kind !== 'unknown') entry.hint.kind = hint.kind;
        if (entry.hint.allowedValues && hint.allowedValues) {
          entry.hint.allowedValues = entry.hint.allowedValues.filter(value => hint.allowedValues.some(item => Object.is(item, value)));
        } else entry.hint.allowedValues ??= hint.allowedValues;
        entry.hint.optional ||= hint.optional;
        entry.hint.nullable ||= hint.nullable;
      }
    }
    return entry;
  };

  for (const item of atoms) {
    if (item.leftExpression) {
      for (const ref of atomExpressionPaths(item)) {
        const hint = resolvePathHint(ref.path, 'unknown', ref.pathTypeHint, pathTypes);
        const entry = ensure(ref.path, hint);
        entry.leftAtoms.push(item);
        entry.accessors.add(ref.accessor ?? 'value');
        entry.expressionOperand = true;
      }
      continue;
    }
    const leftHint = resolvePathHint(item.path, item.pathType, item.pathTypeHint, pathTypes);
    const left = ensure(item.path, leftHint);
    left.leftAtoms.push(item);
    left.accessors.add(item.accessor ?? 'value');
    if (item.valuePath) {
      const rightHint = resolvePathHint(item.valuePath, 'unknown', item.valuePathTypeHint, pathTypes);
      const right = ensure(item.valuePath, rightHint);
      right.rightAtoms.push(item);
      right.accessors.add(item.valueAccessor ?? 'value');
    }
  }

  const numericPathCount = [...byPath.values()].filter(entry => entry.hint?.kind === 'number').length;
  const hasPathRelational = atoms.some(item => (item.valuePath && RELATIONAL.has(item.operator)) || item.leftExpression);
  const arithmeticCandidates = expressionCandidateValues(atoms.filter(item => item.leftExpression));
  for (const entry of byPath.values()) {
    if (entry.typeConflict) throw new TypeError(`Conflicting type hints for path ${entry.path.join('.')}.`);
    const effectiveHint = entry.hint ?? { kind: 'unknown', optional: false, nullable: false, allowedValues: null };
    const usesLength = entry.accessors.has('length');
    if (usesLength && (effectiveHint.kind === 'array' || effectiveHint.kind === 'string')) {
      for (const value of lengthCandidates(entry)) addUnique(entry.values, value);
    }
    if (entry.accessors.has('value') || !usesLength) {
      for (const value of preferredNumericRepresentatives(entry.leftAtoms.filter(item => !item.valuePath), desired)) {
        if (isCompatibleLiteral(value, effectiveHint)) addUnique(entry.values, value);
      }
      for (const value of preferredEqualityRepresentatives(entry.leftAtoms.filter(item => !item.valuePath), desired, effectiveHint)) {
        addUnique(entry.values, value);
      }
      for (const value of typeRepresentatives(effectiveHint, desired)) addUnique(entry.values, value);
      if (entry.expressionOperand && ['number', 'unknown'].includes(effectiveHint.kind)) {
        for (const value of [...arithmeticCandidates, ...arithmeticBoundaryCandidates(atoms.filter(item => item.leftExpression), entry.path)]) {
          if (isCompatibleLiteral(value, effectiveHint)) addUnique(entry.values, value);
        }
      }
      if (hasPathRelational && effectiveHint.kind === 'number') {
        for (let value = 0; value <= numericPathCount; value += 1) {
          if (isCompatibleLiteral(value, effectiveHint)) addUnique(entry.values, value);
        }
        if (isCompatibleLiteral(-1, effectiveHint)) addUnique(entry.values, -1);
      }
    }

    const numericThresholds = entry.leftAtoms
      .filter(item => !item.valuePath && (RELATIONAL.has(item.operator) || EQUALITY.has(item.operator)) && typeof item.value === 'number')
      .map(item => item.value);
    if (numericThresholds.length && (effectiveHint.kind === 'number' || effectiveHint.kind === 'unknown')) {
      for (const value of numericPartition(numericThresholds)) {
        if (isCompatibleLiteral(value, effectiveHint)) addUnique(entry.values, value);
      }
    }

    const seeded = getPathOrUnset(seed, entry.path);
    if (seeded !== UNSET && isCompatibleLiteral(seeded, effectiveHint)) {
      entry.values = [seeded, ...entry.values.filter(value => stableValueKey(value) !== stableValueKey(seeded))];
    }
    if (entry.values.length === 0 && (effectiveHint.kind === 'unknown' || effectiveHint.optional)) entry.values.push(UNSET);

  }

  // Parent paths must be assigned before descendants so object-shape decisions
  // are deterministic and nested constraints cannot mutate a chosen primitive.
  return [...byPath.values()].sort((a, b) => a.path.length - b.path.length || pathKey(a.path).localeCompare(pathKey(b.path)));
}

function isJsonData(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;

  if (Array.isArray(value)) {
    ancestors.add(value);
    const valid = value.every(item => isJsonData(item, ancestors));
    ancestors.delete(value);
    return valid;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  const valid = Object.keys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && isJsonData(descriptor.value, ancestors));
  });
  ancestors.delete(value);
  return valid;
}

function validSeed(seed) {
  return Boolean(seed && typeof seed === 'object' && !Array.isArray(seed) && isJsonData(seed));
}

function validatePathTypes(pathTypes) {
  if (!pathTypes || typeof pathTypes !== 'object' || Array.isArray(pathTypes)) return 'pathTypes must be an object.';
  const prototype = Object.getPrototypeOf(pathTypes);
  if (prototype !== Object.prototype && prototype !== null) return 'pathTypes must be a plain object.';
  if (Object.getOwnPropertySymbols(pathTypes).length > 0) return 'pathTypes must not contain symbol keys.';
  const allowed = new Set(['unknown', 'string', 'number', 'boolean', 'array', 'object']);
  for (const path of Object.keys(pathTypes)) {
    if (!path) return 'pathTypes keys must be non-empty paths.';
    const descriptor = Object.getOwnPropertyDescriptor(pathTypes, path);
    if (!descriptor || !('value' in descriptor)) return `Path type hint ${path} must be a data property.`;
    const hint = descriptor.value;
    if (typeof hint === 'string') {
      if (!allowed.has(hint)) return `Invalid path type hint for ${path}.`;
      continue;
    }
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return `Invalid path type hint for ${path}.`;
    const hintPrototype = Object.getPrototypeOf(hint);
    if (hintPrototype !== Object.prototype && hintPrototype !== null) return `Invalid path type hint for ${path}.`;
    if (Object.getOwnPropertySymbols(hint).length > 0) return `Invalid path type hint for ${path}.`;
    const descriptors = Object.getOwnPropertyDescriptors(hint);
    const kindDescriptor = descriptors.kind ?? descriptors.type;
    const kind = kindDescriptor && 'value' in kindDescriptor ? kindDescriptor.value : undefined;
    const optional = descriptors.optional;
    const nullable = descriptors.nullable;
    const allowedValues = descriptors.allowedValues;
    if (!allowed.has(kind) ||
        (optional && (!('value' in optional) || typeof optional.value !== 'boolean')) ||
        (nullable && (!('value' in nullable) || typeof nullable.value !== 'boolean')) ||
        (allowedValues && (!('value' in allowedValues) || !Array.isArray(allowedValues.value) ||
          allowedValues.value.some(value => !['string', 'number', 'boolean'].includes(typeof value) ||
            (typeof value === 'number' && !Number.isFinite(value)) || typeof value !== kind)))) {
      return `Invalid path type hint for ${path}.`;
    }
  }
  return null;
}

/**
 * Bounded representative solver for typed path/literal, path/path and length constraints.
 * It never labels unsupported syntax as unsatisfiable.
 */
export class ConstraintSolver {
  solve(input, { desired = true, maxCandidates = 128, seed = {}, pathTypes = {} } = {}) {
    const isIR = Boolean(input && typeof input === 'object' && 'irVersion' in input);
    const validation = isIR ? validateConstraintIR(input) : validateConstraintExpr(input);
    if (!validation.valid) {
      return { status: 'unsupported', reason: validation.errors.join('; '), assignments: [], unsupported: [] };
    }
    if (typeof desired !== 'boolean') {
      return { status: 'unsupported', reason: 'desired must be a boolean.', assignments: [], unsupported: [] };
    }
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
      return { status: 'unsupported', reason: 'maxCandidates must be a positive integer.', assignments: [], unsupported: [] };
    }
    if (!validSeed(seed)) {
      return { status: 'unsupported', reason: 'seed must be a JSON-serializable plain object.', assignments: [], unsupported: [] };
    }
    const pathTypeError = validatePathTypes(pathTypes);
    if (pathTypeError) {
      return { status: 'unsupported', reason: pathTypeError, assignments: [], unsupported: [] };
    }

    const expr = isIR ? input.expression : input;
    const { atoms, unsupported } = preflight(expr, pathTypes);
    const hasArithmetic = atoms.some(item => item.leftExpression && (isArithmeticExpression(item.leftExpression) || isArithmeticExpression(item.rightExpression)));
    if (unsupported.length) {
      return {
        status: 'unsupported',
        reason: unsupported.map(item => item.reason).join(' '),
        unsupported: unsupported.map(item => item.id),
        assignments: [],
      };
    }

    let variables;
    try {
      variables = buildDomains(atoms, seed, pathTypes, desired);
    } catch (error) {
      return { status: 'unsupported', reason: error.message, assignments: [], unsupported: [] };
    }
    prioritizeRelationalPairRepresentatives(variables, toShortCircuitDnf(expr, desired, 512)?.[0] ?? []);
    const constrainedPaths = new Set(variables.map(item => pathKey(item.path)));
    let attempts = 0;
    let truncated = false;
    const search = (index, current) => {
      if (index === variables.length) {
        if (attempts >= maxCandidates) {
          truncated = true;
          return null;
        }
        attempts += 1;
        try {
          return evaluateConstraint(expr, current) === desired ? cloneJson(current) : null;
        } catch {
          return null;
        }
      }

      const variable = variables[index];
      for (const value of variable.values) {
        if (attempts >= maxCandidates) {
          truncated = true;
          return null;
        }
        const candidate = cloneJson(current);
        setPath(candidate, variable.path, value, constrainedPaths);
        const found = search(index + 1, candidate);
        if (found) return found;
      }
      return null;
    };

    const assignments = search(0, cloneJson(seed));
    if (assignments) return { status: 'solved', assignments, attempts };
    if (truncated) {
      return {
        status: 'limit-reached',
        reason: `Candidate search stopped after ${attempts} complete assignments.`,
        assignments: [],
        attempts,
      };
    }
    if (hasUnmaterializableLengthClause(expr, desired, pathTypes)) {
      return {
        status: 'limit-reached',
        reason: `A satisfying length may require materialization beyond ${MAX_MATERIALIZED_LENGTH} elements.`,
        assignments: [],
        attempts,
      };
    }
    if (hasArithmetic) {
      return {
        status: 'unsupported',
        reason: 'No arithmetic witness was found in the bounded candidate domain; this is not a proof of unsatisfiability.',
        assignments: [],
        attempts,
        unsupported: atoms.filter(item => item.leftExpression).map(item => item.id),
      };
    }
    return {
      status: 'unsatisfiable',
      reason: 'No assignment in the complete representative domain satisfies the supported expression.',
      assignments: [],
      attempts,
    };
  }
}

/**
 * Expand an outcome into disjoint short-circuit conjunctions. This preserves
 * the exact path witnesses: for `a && b === false`, the clauses are `!a`
 * and `a && !b`; for `a || b === true`, they are `a` and `!a && b`.
 */
function toShortCircuitDnf(expr, desired, maxBranches) {
  const product = (left, right) => {
    const output = [];
    for (const a of left) for (const b of right) {
      output.push([...a, ...b]);
      if (output.length > maxBranches) return null;
    }
    return output;
  };
  const visit = (node, outcome) => {
    if (node.kind === 'constant') return node.value === outcome ? [[]] : [];
    if (node.kind === 'atom') return [[{ atom: node, desired: outcome }]];
    if (node.kind === 'not') return visit(node.operand, !outcome);
    if (node.kind !== 'logical') return null;
    const isAnd = node.operator === 'and';
    const requiresAll = (isAnd && outcome) || (!isAnd && !outcome);
    if (requiresAll) {
      let result = [[]];
      for (const child of node.operands) {
        const childClauses = visit(child, outcome);
        if (childClauses === null) return null;
        result = product(result, childClauses);
        if (result === null || result.length === 0) return result;
      }
      return result;
    }
    const decisive = outcome;
    const continuing = !outcome;
    let prefix = [[]];
    const output = [];
    for (const child of node.operands) {
      const decisiveClauses = visit(child, decisive);
      if (decisiveClauses === null) return null;
      const branch = product(prefix, decisiveClauses);
      if (branch === null) return null;
      output.push(...branch);
      if (output.length > maxBranches) return null;
      const continuingClauses = visit(child, continuing);
      if (continuingClauses === null) return null;
      prefix = product(prefix, continuingClauses);
      if (prefix === null) return null;
      if (!prefix.length) break;
    }
    return output;
  };
  return visit(expr, desired);
}

function collectAtoms(expr) {
  if (expr.kind === 'atom') return [expr];
  if (expr.kind === 'not') return collectAtoms(expr.operand);
  if (expr.kind === 'logical') return expr.operands.flatMap(collectAtoms);
  return [];
}

function atomMatchesCandidate(atomNode, candidate, desired) {
  if (atomNode.leftExpression || atomNode.valuePath) return true; // evaluated after both operand paths are materialized
  let value = candidate === UNSET ? undefined : candidate;
  if (atomNode.accessor === 'length') {
    if (value === null || value === undefined) return false;
    value = value.length;
  }
  try {
    return compare(value, atomNode.operator, resolveLiteral(atomNode.value)) === desired;
  } catch {
    return false;
  }
}

function uniqueAssignmentKey(value) {
  return JSON.stringify(value, (_key, item) => item === undefined ? { $undefined: true } : item);
}

function intersectNumericPathDomain(atoms, desiredByAtom, hint) {
  if (hint?.kind !== 'number' || !atoms.length) return null;
  const domain = { lower: null, upper: null, excluded: [], equalTo: null };
  const inverse = { '<': '>=', '<=': '>', '>': '<=', '>=': '<', '===': '!==', '==': '!=', '!==': '===', '!=': '==' };
  for (const atomNode of atoms) {
    if (!RELATIONAL.has(atomNode.operator) && !EQUALITY.has(atomNode.operator)) return null;
    if (typeof atomNode.value !== 'number' || !Number.isFinite(atomNode.value)) return null;
    const operator = desiredByAtom.get(atomNode.id) === false ? inverse[atomNode.operator] : atomNode.operator;
    const value = atomNode.value;
    if (operator === '>' || operator === '>=') {
      const inclusive = operator === '>=';
      if (domain.lower === null || value > domain.lower.value || (value === domain.lower.value && !inclusive)) {
        domain.lower = { value, inclusive };
      } else if (value === domain.lower.value && !inclusive) domain.lower.inclusive = false;
    } else if (operator === '<' || operator === '<=') {
      const inclusive = operator === '<=';
      if (domain.upper === null || value < domain.upper.value || (value === domain.upper.value && !inclusive)) {
        domain.upper = { value, inclusive };
      } else if (value === domain.upper.value && !inclusive) domain.upper.inclusive = false;
    } else if (operator === '===' || operator === '==') {
      if (domain.equalTo !== null && domain.equalTo !== value) domain.impossible = true;
      domain.equalTo = value;
    } else if (operator === '!==' || operator === '!=') {
      if (!domain.excluded.includes(value)) domain.excluded.push(value);
    }
  }
  if (domain.lower && domain.upper) {
    if (domain.lower.value > domain.upper.value ||
        (domain.lower.value === domain.upper.value && (!domain.lower.inclusive || !domain.upper.inclusive))) {
      domain.impossible = true;
    }
  }
  if (domain.equalTo !== null) {
    const value = domain.equalTo;
    if ((domain.lower && (value < domain.lower.value || (value === domain.lower.value && !domain.lower.inclusive))) ||
        (domain.upper && (value > domain.upper.value || (value === domain.upper.value && !domain.upper.inclusive))) ||
        domain.excluded.includes(value)) domain.impossible = true;
    domain.lower = { value, inclusive: true };
    domain.upper = { value, inclusive: true };
  }
  return domain;
}

function numericDomainAllows(domain, candidate) {
  if (!domain || domain.impossible || typeof candidate !== 'number') return false;
  if (domain.lower && (candidate < domain.lower.value || (candidate === domain.lower.value && !domain.lower.inclusive))) return false;
  if (domain.upper && (candidate > domain.upper.value || (candidate === domain.upper.value && !domain.upper.inclusive))) return false;
  return !domain.excluded.includes(candidate);
}

function summarizeNumericDomain(path, domain, kind = 'numeric-interval') {
  return {
    path: [...path],
    kind,
    ...(domain.lower ? { lower: { ...domain.lower } } : {}),
    ...(domain.upper ? { upper: { ...domain.upper } } : {}),
    ...(domain.excluded.length ? { excluded: [...domain.excluded] } : {}),
    ...(domain.equalTo !== null ? { equalTo: domain.equalTo } : {}),
    ...(domain.impossible ? { impossible: true } : {}),
  };
}

/** True when an integer length satisfying the domain exists beyond the
 * materializer's current 0..MAX_MATERIALIZED_LENGTH range. This is a bounded
 * materialization limitation, never proof of logical unsatisfiability. */
function hasIntegerLengthBeyondLimit(domain, limit = MAX_MATERIALIZED_LENGTH) {
  if (!domain || domain.impossible) return false;
  let first = limit + 1;
  if (domain.lower) {
    const lowerInteger = domain.lower.inclusive
      ? Math.ceil(domain.lower.value)
      : Math.floor(domain.lower.value) + 1;
    first = Math.max(first, lowerInteger);
  }
  let last = Infinity;
  if (domain.upper) {
    last = domain.upper.inclusive
      ? Math.floor(domain.upper.value)
      : Math.ceil(domain.upper.value) - 1;
  }
  if (domain.equalTo !== null) {
    if (!Number.isInteger(domain.equalTo) || domain.equalTo <= limit || domain.excluded.includes(domain.equalTo)) return false;
    return domain.equalTo <= last;
  }
  // The exclusion set is finite, so at most excluded.length + 1 increments
  // are necessary to find a representable integer in the interval.
  let candidate = first;
  for (let index = 0; index <= domain.excluded.length && candidate <= last; index += 1) {
    if (!domain.excluded.includes(candidate)) return true;
    candidate += 1;
  }
  return false;
}

function hasUnmaterializableLengthClause(expr, desired, pathTypes = {}, maxBranches = 512) {
  const clauses = toShortCircuitDnf(expr, desired, maxBranches);
  if (clauses === null) return true;
  for (const clause of clauses) {
    const byPath = new Map();
    for (const item of clause) {
      if (item.atom.accessor !== 'length' || item.atom.valuePath) continue;
      const key = pathKey(item.atom.path);
      if (!byPath.has(key)) byPath.set(key, { path: item.atom.path, atoms: [], desiredByAtom: new Map() });
      const entry = byPath.get(key);
      entry.atoms.push(item.atom);
      entry.desiredByAtom.set(item.atom.id, item.desired);
    }
    for (const entry of byPath.values()) {
      const domain = intersectNumericPathDomain(entry.atoms, entry.desiredByAtom, { kind: 'number' });
      if (hasIntegerLengthBeyondLimit(domain)) return true;
    }
  }
  return false;
}

/**
 * Multi-result solve with path-domain intersection. Each short-circuit clause
 * intersects constraints for the same path before cartesian assignment search.
 * Numeric domains use all threshold points and one representative per open
 * interval, which is complete for supported numeric order predicates.
 */
ConstraintSolver.prototype.solveAll = function solveAll(input, {
  desired = true,
  maxCandidates = 4096,
  maxSolutions = 40,
  maxBranches = 512,
  solutionsPerClause = maxSolutions,
  seed = {},
  pathTypes = {},
} = {}) {
  const isIR = Boolean(input && typeof input === 'object' && 'irVersion' in input);
  const validation = isIR ? validateConstraintIR(input) : validateConstraintExpr(input);
  const fail = (status, reason, unsupported = []) => ({
    status, reason, assignments: [], solutions: [], solutionPaths: [], solutionDomains: [], attempts: 0, complete: false, unsupported,
  });
  if (!validation.valid) return fail('unsupported', validation.errors.join('; '));
  if (typeof desired !== 'boolean') return fail('unsupported', 'desired must be a boolean.');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) return fail('unsupported', 'maxCandidates must be a positive integer.');
  if (!Number.isInteger(maxSolutions) || maxSolutions < 1) return fail('unsupported', 'maxSolutions must be a positive integer.');
  if (!Number.isInteger(maxBranches) || maxBranches < 1) return fail('unsupported', 'maxBranches must be a positive integer.');
  if (!Number.isInteger(solutionsPerClause) || solutionsPerClause < 1) return fail('unsupported', 'solutionsPerClause must be a positive integer.');
  if (!validSeed(seed)) return fail('unsupported', 'seed must be a JSON-serializable plain object.');
  const pathTypeError = validatePathTypes(pathTypes);
  if (pathTypeError) return fail('unsupported', pathTypeError);

  const expr = isIR ? input.expression : input;
  const checked = preflight(expr, pathTypes);
  const hasArithmetic = checked.atoms.some(item => item.leftExpression && (isArithmeticExpression(item.leftExpression) || isArithmeticExpression(item.rightExpression)));
  if (checked.unsupported.length) {
    return fail('unsupported', checked.unsupported.map(item => item.reason).join(' '), checked.unsupported.map(item => item.id));
  }
  const clauses = toShortCircuitDnf(expr, desired, maxBranches);
  if (clauses === null) return fail('limit-reached', `Short-circuit expansion exceeded ${maxBranches} clauses.`);
  if (!clauses.length) {
    return { status: 'unsatisfiable', reason: 'The expression is logically incompatible with the requested outcome.', assignments: [], solutions: [], solutionPaths: [], solutionDomains: [], attempts: 0, complete: true, unsupported: [] };
  }

  let attempts = 0;
  let truncated = false;
  const solutions = [];
  const solutionPaths = [];
  const solutionDomains = [];
  const allDomainIntersections = [];
  const seen = new Set();
  let unresolvedArithmeticClause = false;
  for (const clause of clauses) {
    if (truncated) break;
    const clauseAtoms = clause.map(item => item.atom);
    let variables;
    try {
      variables = buildDomains(clauseAtoms, seed, pathTypes, desired);
    } catch (error) {
      return fail('unsupported', error.message);
    }

    // Ensure every equality literal and its opposite representative are in
    // the candidate universe, regardless of the overall decision polarity.
    const domainIntersections = [];
    for (const variable of variables) {
      const local = clause.filter(item => !item.atom.leftExpression && pathKey(item.atom.path) === pathKey(variable.path));
      const desiredByAtom = new Map(local.map(item => [item.atom.id, item.desired]));
      const literalLocal = local.filter(item => !item.atom.valuePath);
      const usesLength = variable.accessors.has('length');
      const domainAtoms = usesLength
        ? literalLocal.filter(item => item.atom.accessor === 'length').map(item => item.atom)
        : literalLocal.map(item => item.atom);
      const domainHint = usesLength ? { kind: 'number' } : variable.hint;
      variable.numericDomain = intersectNumericPathDomain(domainAtoms, desiredByAtom, domainHint);
      if (variable.numericDomain) domainIntersections.push(summarizeNumericDomain(
        variable.path, variable.numericDomain, usesLength ? 'integer-length' : 'numeric-interval',
      ));
      for (const item of local) {
        if (item.atom.valuePath) continue;
        const literal = resolveLiteral(item.atom.value);
        addUnique(variable.values, literal === undefined ? UNSET : literal);
        if (EQUALITY.has(item.atom.operator)) {
          const other = differentRepresentative(item.atom.value, '!=');
          if (other !== UNSET && isCompatibleLiteral(other, variable.hint ?? { kind: 'unknown', optional: false, nullable: false })) {
            addUnique(variable.values, other);
          }
        }
      }
      variable.values = variable.values.filter(candidate => {
        const metric = usesLength ? (candidate == null ? undefined : candidate.length) : candidate;
        return (!variable.numericDomain || numericDomainAllows(variable.numericDomain, metric)) &&
          local.every(item => atomMatchesCandidate(item.atom, candidate, item.desired));
      });
    }
    prioritizeRelationalPairRepresentatives(variables, clause);
    for (const summary of domainIntersections) {
      if (!allDomainIntersections.some(item => pathKey(item.path) === pathKey(summary.path) && JSON.stringify(item) === JSON.stringify(summary))) {
        allDomainIntersections.push(summary);
      }
    }
    const emptyVariable = variables.find(item => item.values.length === 0);
    if (emptyVariable) {
      if (emptyVariable.accessors.has('length') && hasIntegerLengthBeyondLimit(emptyVariable.numericDomain)) {
        // This clause may be satisfiable, but the current scenario materializer
        // cannot construct the required collection size. Preserve uncertainty.
        truncated = true;
      }
      continue;
    }

    const constrainedPaths = new Set(variables.map(item => pathKey(item.path)));
    const clausePathRefs = clause.flatMap(item => atomExpressionPaths(item.atom));
    const clausePaths = [...new Map(clausePathRefs.map(ref => [pathKey(ref.path), ref.path])).values()].map(path => [...path]);
    let clauseSolutionCount = 0;
    const relationTargets = clause.flatMap(item => {
      if (item.atom.leftExpression || !item.atom.valuePath || !RELATIONAL.has(item.atom.operator)) return [];
      return allowedRelationCategories(item.atom.operator, item.desired)
        .map(category => ({ atom: item.atom, category }));
    });
    const search = (index, current, relationTarget, stopAfterCount) => {
      if (clauseSolutionCount >= stopAfterCount) return;
      if (solutions.length >= maxSolutions || attempts >= maxCandidates) {
        truncated = true;
        return;
      }
      if (index === variables.length) {
        attempts += 1;
        try {
          if (relationTarget && relationCategory(relationTarget.atom, current) !== relationTarget.category) return;
          if (evaluateConstraint(expr, current) !== desired) return;
        } catch {
          return;
        }
        const key = uniqueAssignmentKey(current);
        if (!seen.has(key)) {
          seen.add(key);
          solutions.push(cloneJson(current));
          solutionPaths.push(clausePaths);
          solutionDomains.push(domainIntersections.map(item => ({ ...item, path: [...item.path] })));
          clauseSolutionCount += 1;
        }
        return;
      }
      const variable = variables[index];
      for (const value of variable.values) {
        if (clauseSolutionCount >= stopAfterCount) return;
        if (solutions.length >= maxSolutions || attempts >= maxCandidates) {
          truncated = true;
          return;
        }
        const candidate = cloneJson(current);
        setPath(candidate, variable.path, value, constrainedPaths);
        search(index + 1, candidate, relationTarget, stopAfterCount);
      }
    };
    if (relationTargets.length) {
      // A non-strict outcome of a strict comparison spans two semantically
      // different regions (e.g. x < y is false for both x > y and x === y).
      // Preserve one witness for each region so subsequent conditions can
      // refine the incoming path without losing the equality boundary.
      for (const target of relationTargets) {
        if (solutions.length >= maxSolutions || attempts >= maxCandidates) {
          truncated = true;
          break;
        }
        search(0, cloneJson(seed), target, clauseSolutionCount + solutionsPerClause);
      }
    } else {
      search(0, cloneJson(seed), null, solutionsPerClause);
    }
    if (clauseSolutionCount === 0 && hasArithmetic && clause.some(item => item.atom.leftExpression)) {
      unresolvedArithmeticClause = true;
    }
  }

  if (solutions.length) {
    const incomplete = truncated || unresolvedArithmeticClause;
    return {
      status: 'solved', assignments: solutions[0], solutions, solutionPaths, solutionDomains, attempts,
      complete: !incomplete, truncated: incomplete, unsupported: [], domainIntersections: allDomainIntersections,
      ...(hasArithmetic ? { heuristic: true } : {}),
    };
  }
  if (truncated) {
    return {
      status: 'limit-reached', reason: `Multi-result search stopped after ${attempts} complete assignments or a configured result limit.`,
      assignments: [], solutions: [], solutionPaths: [], solutionDomains: [], attempts, complete: false, unsupported: [],
    };
  }
  if (hasArithmetic) {
    return fail('unsupported', 'No arithmetic witness was found in the bounded candidate domain; this is not a proof of unsatisfiability.',
      checked.atoms.filter(item => item.leftExpression).map(item => item.id));
  }
  return {
    status: 'unsatisfiable', reason: 'No assignment in the intersected representative domains satisfies the requested outcome.',
    assignments: [], solutions: [], solutionPaths: [], solutionDomains: [], attempts, complete: true, unsupported: [], domainIntersections: allDomainIntersections,
  };
};
