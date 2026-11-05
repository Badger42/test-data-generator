/**
 * Versioned, parser-independent Constraint IR.
 *
 * The IR is deliberately JSON-safe and contains no parser/compiler objects.
 * `valuePath` and accessors preserve typed path-to-path and collection-length
 * semantics independently of the TypeScript compiler front-end.
 */
export const CONSTRAINT_IR_VERSION = 2;
export const SUPPORTED_CONSTRAINT_IR_VERSIONS = Object.freeze([1, 2]);

export const CONSTRAINT_OPERATORS = Object.freeze([
  'truthy', '==', '===', '!=', '!==', '<', '<=', '>', '>=', 'unsupported',
]);

const OPERATOR_SET = new Set(CONSTRAINT_OPERATORS);
const VALUE_TYPES = new Set(['unknown', 'string', 'number', 'boolean', 'null', 'undefined']);
const ACCESSORS = new Set(['value', 'length']);
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** JSON-safe representation of the JavaScript `undefined` literal. */
export const CONSTRAINT_UNDEFINED = Object.freeze({ $constraintValue: 'undefined' });

export function isConstraintUndefined(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && value.$constraintValue === 'undefined');
}

export function constraintValueType(value) {
  if (isConstraintUndefined(value)) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return typeof value;
  return 'unknown';
}

export function atom({
  id,
  path = [],
  accessor = 'value',
  operator = 'truthy',
  value,
  valuePath,
  valueAccessor = 'value',
  valuePathTypeHint,
  source = null,
  valueType,
  pathType = 'unknown',
  pathTypeHint,
  unsupportedReason,
  leftExpression,
  rightExpression,
}) {
  const result = {
    kind: 'atom',
    id,
    path: Array.isArray(path) ? [...path] : path,
    accessor,
    operator,
    source: source == null ? null : { ...source },
    valueType: valueType ?? (valuePath || leftExpression ? 'unknown' : constraintValueType(value)),
    pathType: pathTypeHint?.kind ?? pathType,
  };
  if (pathTypeHint !== undefined) {
    result.pathTypeHint = {
      kind: pathTypeHint.kind,
      ...(pathTypeHint.optional === true ? { optional: true } : {}),
      ...(pathTypeHint.nullable === true ? { nullable: true } : {}),
      ...(Array.isArray(pathTypeHint.allowedValues) ? { allowedValues: [...new Set(pathTypeHint.allowedValues)] } : {}),
    };
  }
  if (leftExpression !== undefined) result.leftExpression = leftExpression;
  if (rightExpression !== undefined) result.rightExpression = rightExpression;
  if (valuePath !== undefined) {
    result.valuePath = Array.isArray(valuePath) ? [...valuePath] : valuePath;
    result.valueAccessor = valueAccessor;
    if (valuePathTypeHint !== undefined) {
      result.valuePathTypeHint = {
        kind: valuePathTypeHint.kind,
        ...(valuePathTypeHint.optional === true ? { optional: true } : {}),
        ...(valuePathTypeHint.nullable === true ? { nullable: true } : {}),
        ...(Array.isArray(valuePathTypeHint.allowedValues) ? { allowedValues: [...new Set(valuePathTypeHint.allowedValues)] } : {}),
      };
    }
  } else if (operator !== 'truthy' && operator !== 'unsupported') {
    result.value = value;
  }
  if (unsupportedReason) result.unsupportedReason = unsupportedReason;
  return result;
}

/** Build a canonical logical node (flattening and folding boolean constants). */
export function logical(operator, operands) {
  if (!['and', 'or'].includes(operator)) throw new TypeError(`Unsupported logical operator: ${operator}`);
  if (!Array.isArray(operands) || operands.length < 2) {
    throw new TypeError('Logical nodes require at least two operands.');
  }

  const flattened = [];
  for (const operand of operands) {
    if (operand?.kind === 'logical' && operand.operator === operator) flattened.push(...operand.operands);
    else flattened.push(operand);
  }

  const identity = operator === 'and';
  const annihilator = !identity;
  if (flattened.some(item => item?.kind === 'constant' && item.value === annihilator)) {
    return constant(annihilator);
  }
  const remaining = flattened.filter(item => !(item?.kind === 'constant' && item.value === identity));
  if (remaining.length === 0) return constant(identity);
  if (remaining.length === 1) return remaining[0];
  return { kind: 'logical', operator, operands: remaining };
}

export function negate(operand) {
  if (operand?.kind === 'constant') return constant(!operand.value);
  if (operand?.kind === 'not') return operand.operand;
  return { kind: 'not', operand };
}

export function constant(value) {
  return { kind: 'constant', value: Boolean(value) };
}

export function collectConstraintAtoms(expr, output = []) {
  if (expr?.kind === 'atom') output.push(expr);
  else if (expr?.kind === 'logical' && Array.isArray(expr.operands)) {
    expr.operands.forEach(child => collectConstraintAtoms(child, output));
  } else if (expr?.kind === 'not') {
    collectConstraintAtoms(expr.operand, output);
  }
  return output;
}

/** Return every concrete path referenced by an atom, including arithmetic operands. */
export function collectConstraintPaths(expr, output = []) {
  const addValuePaths = valueExpr => {
    if (!valueExpr || typeof valueExpr !== 'object') return;
    if (valueExpr.kind === 'path') output.push({
      path: [...valueExpr.path], accessor: valueExpr.accessor ?? 'value',
      pathTypeHint: valueExpr.pathTypeHint,
    });
    else if (valueExpr.kind === 'unary') addValuePaths(valueExpr.operand);
    else if (valueExpr.kind === 'binary') {
      addValuePaths(valueExpr.left);
      addValuePaths(valueExpr.right);
    }
  };
  for (const item of collectConstraintAtoms(expr)) {
    if (item.leftExpression) addValuePaths(item.leftExpression);
    if (item.rightExpression) addValuePaths(item.rightExpression);
    if (!item.leftExpression && Array.isArray(item.path) && item.path.length) {
      output.push({ path: [...item.path], accessor: item.accessor ?? 'value', pathTypeHint: item.pathTypeHint });
    }
    if (!item.leftExpression && item.valuePath) output.push({
      path: [...item.valuePath], accessor: item.valueAccessor ?? 'value', pathTypeHint: item.valuePathTypeHint,
    });
  }
  const unique = new Map();
  for (const item of output) unique.set(JSON.stringify([item.path, item.accessor]), item);
  return [...unique.values()];
}

export function createConstraintIR(expression) {
  const atoms = collectConstraintAtoms(expression);
  const diagnostics = atoms
    .filter(item => item.operator === 'unsupported')
    .map(item => ({
      code: 'UNSUPPORTED_EXPRESSION',
      atomId: item.id,
      message: item.unsupportedReason ?? 'The expression is not supported by the compiler.',
    }));
  return { irVersion: CONSTRAINT_IR_VERSION, expression, atoms, diagnostics };
}

function isSafePath(path) {
  return Array.isArray(path) && path.length > 0 &&
    path.every(part => typeof part === 'string' && part.length > 0 && !DANGEROUS_PATH_SEGMENTS.has(part));
}

function isLiteral(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) || isConstraintUndefined(value);
}

function validSource(source) {
  if (source === null) return true;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  if (source.file !== undefined && typeof source.file !== 'string') return false;
  if (source.start !== undefined && (!Number.isInteger(source.start) || source.start < 0)) return false;
  if (source.end !== undefined && (!Number.isInteger(source.end) || source.end < 0)) return false;
  if (source.start !== undefined && source.end !== undefined && source.end < source.start) return false;
  return true;
}

function validateConstraintValueExpr(node, nodePath, errors, seen) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${nodePath}: expected value expression object`);
    return;
  }
  if (seen.has(node)) {
    errors.push(`${nodePath}: cyclic or reused value expression reference`);
    return;
  }
  seen.add(node);
  if (node.kind === 'literal') {
    if (!isLiteral(node.value)) errors.push(`${nodePath}.value: expected a JSON-safe primitive or undefined marker`);
  } else if (node.kind === 'path') {
    if (!isSafePath(node.path)) errors.push(`${nodePath}.path: expected a non-empty safe string path`);
    if (node.accessor !== undefined && !ACCESSORS.has(node.accessor)) errors.push(`${nodePath}.accessor: expected value/length`);
    if (node.pathTypeHint !== undefined) {
      const hint = node.pathTypeHint;
      const allowedKinds = ['unknown', 'string', 'number', 'boolean', 'array', 'object'];
      if (!hint || typeof hint !== 'object' || Array.isArray(hint) || !allowedKinds.includes(hint.kind) ||
          (hint.optional !== undefined && typeof hint.optional !== 'boolean') ||
          (hint.nullable !== undefined && typeof hint.nullable !== 'boolean') ||
          (hint.allowedValues !== undefined && (!Array.isArray(hint.allowedValues) || hint.allowedValues.some(value =>
            !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) ||
            (hint.kind !== 'unknown' && typeof value !== hint.kind))))) {
        errors.push(`${nodePath}.pathTypeHint: invalid path type hint`);
      }
    }
  } else if (node.kind === 'unary') {
    if (!['+', '-'].includes(node.operator)) errors.push(`${nodePath}.operator: expected unary + or -`);
    validateConstraintValueExpr(node.operand, `${nodePath}.operand`, errors, seen);
  } else if (node.kind === 'binary') {
    if (!['+', '-', '*', '/', '%', '**'].includes(node.operator)) errors.push(`${nodePath}.operator: unsupported arithmetic operator`);
    validateConstraintValueExpr(node.left, `${nodePath}.left`, errors, seen);
    validateConstraintValueExpr(node.right, `${nodePath}.right`, errors, seen);
  } else {
    errors.push(`${nodePath}.kind: unknown value expression kind ${String(node.kind)}`);
  }
}

export function validateConstraintExpr(expr) {
  const errors = [];
  const atomIds = new Set();
  const visited = new WeakSet();

  const visit = (node, nodePath = '$') => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${nodePath}: expected node object`);
      return;
    }
    if (visited.has(node)) {
      errors.push(`${nodePath}: cyclic or reused node reference`);
      return;
    }
    visited.add(node);

    if (node.kind === 'atom') {
      if (typeof node.id !== 'string' || node.id.trim() === '') errors.push(`${nodePath}.id: expected non-empty string`);
      else if (atomIds.has(node.id)) errors.push(`${nodePath}.id: duplicate atom id ${node.id}`);
      else atomIds.add(node.id);

      const expressionAtom = node.leftExpression !== undefined;
      if (node.operator !== 'unsupported' && !expressionAtom && !isSafePath(node.path)) {
        errors.push(`${nodePath}.path: expected a non-empty safe string path`);
      }
      if (expressionAtom) {
        validateConstraintValueExpr(node.leftExpression, `${nodePath}.leftExpression`, errors, visited);
        if (node.rightExpression !== undefined) validateConstraintValueExpr(node.rightExpression, `${nodePath}.rightExpression`, errors, visited);
        if (node.valuePath !== undefined || node.value !== undefined) {
          errors.push(`${nodePath}: expression atoms cannot also carry direct path/value fields`);
        }
        if (node.operator === 'unsupported') errors.push(`${nodePath}: expression atom cannot use unsupported operator`);
      }
      if (node.operator === 'unsupported' && node.path !== undefined &&
          (!Array.isArray(node.path) || node.path.some(part => typeof part !== 'string'))) {
        errors.push(`${nodePath}.path: expected string[]`);
      }
      if (!OPERATOR_SET.has(node.operator)) errors.push(`${nodePath}.operator: unsupported operator ${String(node.operator)}`);
      if (node.accessor !== undefined && !ACCESSORS.has(node.accessor)) errors.push(`${nodePath}.accessor: expected value/length`);
      if (node.valueAccessor !== undefined && !ACCESSORS.has(node.valueAccessor)) errors.push(`${nodePath}.valueAccessor: expected value/length`);
      if (node.valuePath !== undefined && !isSafePath(node.valuePath)) errors.push(`${nodePath}.valuePath: expected a non-empty safe string path`);
      if (!expressionAtom && node.valuePath === undefined && node.operator !== 'truthy' && node.operator !== 'unsupported' && !isLiteral(node.value)) {
        errors.push(`${nodePath}.value: expected a JSON-safe primitive or undefined marker`);
      }
      if (node.valueType !== undefined && !VALUE_TYPES.has(node.valueType)) errors.push(`${nodePath}.valueType: unknown value type`);
      if (node.pathType !== undefined && !['unknown', 'string', 'number', 'boolean', 'array', 'object'].includes(node.pathType)) {
        errors.push(`${nodePath}.pathType: unknown path type`);
      }
      if (node.pathTypeHint !== undefined) {
        const hint = node.pathTypeHint;
        const allowedKinds = ['unknown', 'string', 'number', 'boolean', 'array', 'object'];
        const validAllowedValues = hint && typeof hint === 'object' &&
          (hint.allowedValues === undefined || (Array.isArray(hint.allowedValues) && hint.allowedValues.every(value =>
            ['string', 'number', 'boolean'].includes(typeof value) &&
            (typeof value !== 'number' || Number.isFinite(value)) &&
            (hint.kind === 'unknown' || typeof value === hint.kind))));
        if (!hint || typeof hint !== 'object' || Array.isArray(hint) || !allowedKinds.includes(hint.kind) ||
            (hint.optional !== undefined && typeof hint.optional !== 'boolean') ||
            (hint.nullable !== undefined && typeof hint.nullable !== 'boolean') || !validAllowedValues) {
          errors.push(`${nodePath}.pathTypeHint: invalid path type hint`);
        }
      }
      if (node.valuePathTypeHint !== undefined) {
        const hint = node.valuePathTypeHint;
        const allowedKinds = ['unknown', 'string', 'number', 'boolean', 'array', 'object'];
        const validAllowedValues = hint && typeof hint === 'object' &&
          (hint.allowedValues === undefined || (Array.isArray(hint.allowedValues) && hint.allowedValues.every(value =>
            ['string', 'number', 'boolean'].includes(typeof value) &&
            (typeof value !== 'number' || Number.isFinite(value)) &&
            (hint.kind === 'unknown' || typeof value === hint.kind))));
        if (!hint || typeof hint !== 'object' || Array.isArray(hint) || !allowedKinds.includes(hint.kind) ||
            (hint.optional !== undefined && typeof hint.optional !== 'boolean') ||
            (hint.nullable !== undefined && typeof hint.nullable !== 'boolean') || !validAllowedValues) {
          errors.push(`${nodePath}.valuePathTypeHint: invalid path type hint`);
        }
      }
      if (!validSource(node.source ?? null)) errors.push(`${nodePath}.source: invalid source span`);
      if (node.operator === 'unsupported' &&
          (typeof node.unsupportedReason !== 'string' || node.unsupportedReason.trim() === '')) {
        errors.push(`${nodePath}.unsupportedReason: expected a non-empty explanation`);
      }
    } else if (node.kind === 'logical') {
      if (!['and', 'or'].includes(node.operator)) errors.push(`${nodePath}.operator: expected and/or`);
      if (!Array.isArray(node.operands) || node.operands.length < 2) {
        errors.push(`${nodePath}.operands: expected at least two nodes`);
      } else {
        node.operands.forEach((child, index) => visit(child, `${nodePath}.operands[${index}]`));
      }
    } else if (node.kind === 'not') {
      visit(node.operand, `${nodePath}.operand`);
    } else if (node.kind === 'constant') {
      if (typeof node.value !== 'boolean') errors.push(`${nodePath}.value: expected boolean`);
    } else {
      errors.push(`${nodePath}.kind: unknown node kind ${String(node.kind)}`);
    }
  };

  visit(expr);
  return { valid: errors.length === 0, errors };
}

export function validateConstraintIR(ir) {
  const errors = [];
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) {
    return { valid: false, errors: ['$: expected ConstraintIR object'] };
  }
  if (!SUPPORTED_CONSTRAINT_IR_VERSIONS.includes(ir.irVersion)) errors.push(`$.irVersion: expected one of ${SUPPORTED_CONSTRAINT_IR_VERSIONS.join(', ')}`);

  const expressionValidation = validateConstraintExpr(ir.expression);
  errors.push(...expressionValidation.errors.map(error => `$.expression${error.slice(1)}`));
  const expectedAtoms = collectConstraintAtoms(ir.expression);

  if (!Array.isArray(ir.atoms)) errors.push('$.atoms: expected ConstraintAtom[]');
  else if (ir.atoms.length !== expectedAtoms.length) errors.push('$.atoms: atom index does not match expression tree');
  else {
    for (let index = 0; index < expectedAtoms.length; index += 1) {
      if (ir.atoms[index]?.id !== expectedAtoms[index].id) {
        errors.push(`$.atoms[${index}]: expected atom ${expectedAtoms[index].id} in expression order`);
      }
    }
  }

  if (!Array.isArray(ir.diagnostics)) errors.push('$.diagnostics: expected array');
  else {
    const ids = new Set(expectedAtoms.map(item => item.id));
    ir.diagnostics.forEach((diagnostic, index) => {
      if (!diagnostic || typeof diagnostic !== 'object' || typeof diagnostic.code !== 'string' ||
          typeof diagnostic.atomId !== 'string' || !ids.has(diagnostic.atomId)) {
        errors.push(`$.diagnostics[${index}]: malformed diagnostic or unknown atom id`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}
