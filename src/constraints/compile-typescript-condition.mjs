import {
  CONSTRAINT_UNDEFINED,
  atom,
  constant,
  createConstraintIR,
  logical,
  negate,
  validateConstraintIR,
} from './constraint-ir.mjs';

function comparisonOperator(kind, ts) {
  if (kind === ts.SyntaxKind.EqualsEqualsToken) return '==';
  if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return '===';
  if (kind === ts.SyntaxKind.ExclamationEqualsToken) return '!=';
  if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return '!==';
  if (kind === ts.SyntaxKind.LessThanToken) return '<';
  if (kind === ts.SyntaxKind.LessThanEqualsToken) return '<=';
  if (kind === ts.SyntaxKind.GreaterThanToken) return '>';
  if (kind === ts.SyntaxKind.GreaterThanEqualsToken) return '>=';
  return null;
}
const REVERSE_OPERATORS = Object.freeze({
  '<': '>', '<=': '>=', '>': '<', '>=': '<=',
  '==': '==', '===': '===', '!=': '!=', '!==': '!==',
});

/**
 * Compile a TypeScript compiler expression into parser-independent IR.
 * `ts` is injected so this module does not import or own a parser dependency.
 */
export function compileTypescriptCondition(node, ts, options = {}) {
  let nextId = 0;

  const sourceFor = current => {
    if (options.source !== undefined) return options.source;
    try {
      const sourceFile = current.getSourceFile?.();
      const start = current.getStart?.(sourceFile);
      const end = current.end;
      return {
        ...(sourceFile?.fileName ? { file: sourceFile.fileName } : {}),
        ...(Number.isInteger(start) && start >= 0 ? { start } : {}),
        ...(Number.isInteger(end) && end >= 0 ? { end } : {}),
      };
    } catch {
      return null;
    }
  };

  const pathTypeFor = path => {
    const hints = options.pathTypes ?? {};
    const hint = hints[JSON.stringify(path)] ?? hints[path.join('.')];
    const allowed = ['unknown', 'string', 'number', 'boolean', 'array', 'object'];
    if (hint === undefined) return { kind: 'unknown' };
    if (typeof hint === 'string') {
      if (!allowed.includes(hint)) throw new TypeError(`Unsupported path type hint: ${hint}`);
      return { kind: hint };
    }
    if (!hint || typeof hint !== 'object' || Array.isArray(hint) ||
        !allowed.includes(hint.kind ?? hint.type) ||
        (hint.optional !== undefined && typeof hint.optional !== 'boolean') ||
        (hint.nullable !== undefined && typeof hint.nullable !== 'boolean') ||
        (hint.allowedValues !== undefined && (!Array.isArray(hint.allowedValues) ||
          hint.allowedValues.some(value => !['string', 'number', 'boolean'].includes(typeof value) ||
            (typeof value === 'number' && !Number.isFinite(value)))))) {
      throw new TypeError(`Invalid path type hint for ${path.join('.')}.`);
    }
    const kind = hint.kind ?? hint.type;
    if (hint.allowedValues?.some(value => typeof value !== kind)) {
      throw new TypeError(`Literal path values must match the ${kind} type for ${path.join('.')}.`);
    }
    return {
      kind,
      ...(hint.optional === true ? { optional: true } : {}),
      ...(hint.nullable === true ? { nullable: true } : {}),
      ...(hint.allowedValues ? { allowedValues: [...new Set(hint.allowedValues)] } : {}),
    };
  };

  const compilePathHint = path => {
    const pathTypeHint = pathTypeFor(path);
    return { pathType: pathTypeHint.kind, pathTypeHint };
  };

  const getPath = current => {
    if (!current) return null;
    if (ts.isParenthesizedExpression(current)) return getPath(current.expression);
    if (ts.isIdentifier(current)) {
      if (current.text === 'undefined') return null;
      return { path: [current.text], accessor: 'value' };
    }
    if (ts.isPropertyAccessExpression(current)) {
      const parent = getPath(current.expression);
      if (!parent || parent.accessor !== 'value') return null;
      if (current.name.text === 'length') return { path: parent.path, accessor: 'length' };
      return { path: [...parent.path, current.name.text], accessor: 'value' };
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      const argument = literal(current.argumentExpression);
      if (!argument.ok || (typeof argument.value !== 'string' && typeof argument.value !== 'number')) return null;
      const parent = getPath(current.expression);
      if (!parent || parent.accessor !== 'value') return null;
      const segment = String(argument.value);
      if (segment === 'length') return { path: parent.path, accessor: 'length' };
      return { path: [...parent.path, segment], accessor: 'value' };
    }
    return null;
  };

  const literal = current => {
    if (ts.isParenthesizedExpression(current)) return literal(current.expression);
    if (ts.isStringLiteralLike(current) || ts.isNoSubstitutionTemplateLiteral?.(current)) {
      return { ok: true, value: current.text };
    }
    if (ts.isNumericLiteral(current)) {
      const value = Number(current.text);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (ts.isPrefixUnaryExpression(current) &&
        (current.operator === ts.SyntaxKind.MinusToken || current.operator === ts.SyntaxKind.PlusToken) &&
        ts.isNumericLiteral(current.operand)) {
      const value = Number(current.operand.text) * (current.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
      return Number.isFinite(value) ? { ok: true, value } : { ok: false };
    }
    if (current.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
    if (current.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
    if (current.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
    if (ts.isIdentifier(current) && current.text === 'undefined') return { ok: true, value: CONSTRAINT_UNDEFINED };
    return { ok: false };
  };

  const arithmeticOperator = kind => ({
    [ts.SyntaxKind.PlusToken]: '+',
    [ts.SyntaxKind.MinusToken]: '-',
    [ts.SyntaxKind.AsteriskToken]: '*',
    [ts.SyntaxKind.SlashToken]: '/',
    [ts.SyntaxKind.PercentToken]: '%',
    [ts.SyntaxKind.AsteriskAsteriskToken]: '**',
  })[kind] ?? null;

  const rootIdentifier = current => {
    let value = current;
    while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) value = value.expression;
    return value && ts.isIdentifier(value) ? value : null;
  };

  const pathExpression = (current, aliases = new Set(), depth = 0) => {
    if (!current || depth > 12) return null;
    const root = rootIdentifier(current);
    if (root && options.isSymbolicRoot && !options.isSymbolicRoot(root)) return null;
    const raw = getPath(current);
    if (!raw) return null;
    const rawPath = raw.path;
    if (root && options.resolveAlias) {
      let resolved;
      try { resolved = options.resolveAlias(root); } catch { resolved = null; }
      if (resolved && !aliases.has(root)) {
        const nextAliases = new Set(aliases);
        nextAliases.add(root);
        const aliasExpr = valueExpression(resolved, nextAliases, depth + 1);
        if (aliasExpr?.kind === 'path') {
          return {
            ...aliasExpr,
            path: [...aliasExpr.path, ...rawPath.slice(1)],
            accessor: raw.accessor ?? aliasExpr.accessor ?? 'value',
          };
        }
        // A local constant/computed value is not a new input path.
        return null;
      }
    }
    const path = rawPath;
    if (!path.length) return null;
    const hint = pathTypeFor(path);
    return { kind: 'path', path, accessor: raw.accessor ?? 'value', pathTypeHint: hint };
  };

  const valueExpression = (current, aliases = new Set(), depth = 0) => {
    if (!current || depth > 12) return null;
    if (current.kind === 'constraint-path' && Array.isArray(current.path) && current.path.length) {
      return { kind: 'path', path: [...current.path], accessor: 'value' };
    }
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression?.(current)) return valueExpression(current.expression, aliases, depth + 1);

    if (ts.isIdentifier(current) && options.resolveAlias && !aliases.has(current)) {
      let resolved;
      try { resolved = options.resolveAlias(current); } catch { resolved = null; }
      if (resolved) {
        const nextAliases = new Set(aliases);
        nextAliases.add(current);
        const aliasValue = valueExpression(resolved, nextAliases, depth + 1);
        if (aliasValue) return aliasValue;
      }
    }

    const directLiteral = literal(current);
    if (directLiteral.ok) return { kind: 'literal', value: directLiteral.value };

    const directPath = pathExpression(current, aliases, depth + 1);
    if (directPath) return directPath;

    if (ts.isPrefixUnaryExpression(current) &&
        [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(current.operator)) {
      const operand = valueExpression(current.operand, aliases, depth + 1);
      if (!operand) return null;
      return { kind: 'unary', operator: current.operator === ts.SyntaxKind.MinusToken ? '-' : '+', operand };
    }
    if (ts.isBinaryExpression(current)) {
      const operator = arithmeticOperator(current.operatorToken.kind);
      if (!operator) return null;
      // Only numeric + is modelled. String concatenation is deliberately unsupported.
      if (operator === '+' && (!options.isNumericExpression || !options.isNumericExpression(current))) return null;
      const left = valueExpression(current.left, aliases, depth + 1);
      const right = valueExpression(current.right, aliases, depth + 1);
      if (!left || !right) return null;
      return { kind: 'binary', operator, left, right };
    }
    return null;
  };

  const unsupported = (current, reason) => atom({
    id: `C${++nextId}`,
    path: [],
    operator: 'unsupported',
    source: sourceFor(current),
    unsupportedReason: reason,
  });

  const visit = current => {
    if (ts.isParenthesizedExpression(current)) return visit(current.expression);

    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
      return negate(visit(current.operand));
    }

    if (ts.isBinaryExpression(current)) {
      const operatorKind = current.operatorToken.kind;
      if (operatorKind === ts.SyntaxKind.AmpersandAmpersandToken || operatorKind === ts.SyntaxKind.BarBarToken) {
        const operator = operatorKind === ts.SyntaxKind.AmpersandAmpersandToken ? 'and' : 'or';
        return logical(operator, [visit(current.left), visit(current.right)]);
      }

      const operator = comparisonOperator(operatorKind, ts);
      if (operator) {
        const leftPath = pathExpression(current.left);
        const rightPath = pathExpression(current.right);
        const leftLiteral = literal(current.left);
        const rightLiteral = literal(current.right);
        const source = sourceFor(current);

        if (leftPath && rightPath) {
          return atom({
            id: `C${++nextId}`,
            path: leftPath.path,
            accessor: leftPath.accessor,
            ...compilePathHint(leftPath.path),
            operator,
            valuePath: rightPath.path,
            valueAccessor: rightPath.accessor,
            valuePathTypeHint: pathTypeFor(rightPath.path),
            source,
          });
        }
        if (leftPath && rightLiteral.ok) {
          return atom({
            id: `C${++nextId}`,
            path: leftPath.path,
            accessor: leftPath.accessor,
            ...compilePathHint(leftPath.path),
            operator,
            value: rightLiteral.value,
            source,
          });
        }
        if (rightPath && leftLiteral.ok) {
          return atom({
            id: `C${++nextId}`,
            path: rightPath.path,
            accessor: rightPath.accessor,
            ...compilePathHint(rightPath.path),
            operator: REVERSE_OPERATORS[operator],
            value: leftLiteral.value,
            source,
          });
        }

        const leftExpression = valueExpression(current.left);
        const rightExpression = valueExpression(current.right);
        if (leftExpression?.kind === 'literal' && rightExpression?.kind === 'literal') {
          const leftValue = leftExpression.value === CONSTRAINT_UNDEFINED ? undefined : leftExpression.value;
          const rightValue = rightExpression.value === CONSTRAINT_UNDEFINED ? undefined : rightExpression.value;
          // eslint-disable-next-line eqeqeq
          const result = operator === '===' ? leftValue === rightValue
            : operator === '!==' ? leftValue !== rightValue
              : operator === '==' ? leftValue == rightValue
                : operator === '!=' ? leftValue != rightValue
                  : operator === '<' ? leftValue < rightValue
                    : operator === '<=' ? leftValue <= rightValue
                      : operator === '>' ? leftValue > rightValue
                        : leftValue >= rightValue;
          return constant(result);
        }
        if (leftExpression && rightExpression) {
          return atom({
            id: `C${++nextId}`,
            path: [],
            operator,
            leftExpression,
            rightExpression,
            source,
          });
        }
        return unsupported(current, 'Comparison must have supported paths, literals or bounded arithmetic expressions.');
      }

      return unsupported(current, `Binary operator ${ts.tokenToString?.(operatorKind) ?? ts.SyntaxKind[operatorKind]} is not supported by Constraint IR v2.`);
    }

    const value = literal(current);
    if (value.ok) return constant(Boolean(value.value) && value.value !== CONSTRAINT_UNDEFINED);

    const path = pathExpression(current);
    if (path) {
      return atom({
        id: `C${++nextId}`,
        path: path.path,
        accessor: path.accessor,
        ...compilePathHint(path.path),
        operator: 'truthy',
        source: sourceFor(current),
      });
    }
    const expression = valueExpression(current);
    if (expression) {
      return atom({
        id: `C${++nextId}`,
        path: [],
        operator: 'truthy',
        leftExpression: expression,
        source: sourceFor(current),
      });
    }

    return unsupported(current, `Expression kind ${ts.SyntaxKind[current.kind] ?? current.kind} is not supported by Constraint IR v2.`);
  };

  const ir = createConstraintIR(visit(node));
  const validation = validateConstraintIR(ir);
  if (!validation.valid) throw new TypeError(`Invalid Constraint IR: ${validation.errors.join('; ')}`);
  return ir;
}
