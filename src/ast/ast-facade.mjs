/**
 * TypeScript AST facade. The compiler API is injected by the project adapter;
 * this module never imports TypeScript and exposes only AST-aware operations.
 */
export function createAstFacade(ts) {
  if (!ts) throw new TypeError('AstFacade requires a TypeScript API instance.');

  function unwrapExpression(node) {
    let current = node;
    while (current && (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression?.(current)
    )) current = current.expression;
    return current;
  }

  function readLiteral(node, undefinedValue) {
    const current = unwrapExpression(node);
    if (!current) return { ok: false };
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) return { ok: true, value: current.text };
    if (ts.isNumericLiteral(current)) return { ok: true, value: Number(current.text) };
    if (current.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
    if (current.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
    if (current.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
    if (ts.isIdentifier(current) && current.text === 'undefined') return { ok: true, value: undefinedValue };
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
      const inner = readLiteral(current.operand, undefinedValue);
      if (inner.ok && typeof inner.value === 'number') return { ok: true, value: -inner.value };
    }
    return { ok: false };
  }

  function getPath(node) {
    const current = unwrapExpression(node);
    if (!current) return null;
    if (ts.isIdentifier(current)) return [current.text];
    if (ts.isPropertyAccessExpression(current)) {
      const parent = getPath(current.expression);
      return parent ? [...parent, current.name.text] : null;
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      const key = readLiteral(current.argumentExpression, undefined);
      const parent = getPath(current.expression);
      if (parent && key.ok && (typeof key.value === 'string' || typeof key.value === 'number')) return [...parent, String(key.value)];
    }
    return null;
  }

  function getPathWithAliases(node, aliases = new Map()) {
    const current = unwrapExpression(node);
    if (!current) return null;

    const rawPath = getPath(current);
    if (rawPath?.length) {
      const alias = aliases.get(rawPath[0]);
      if (alias?.kind === 'path') return [...alias.path, ...rawPath.slice(1)];
      if (alias?.kind === 'object' && rawPath.length > 1) {
        const fieldAlias = alias.fields?.[rawPath[1]];
        if (fieldAlias?.kind === 'path') return [...fieldAlias.path, ...rawPath.slice(2)];
        if (fieldAlias?.kind === 'object' && rawPath.length > 2) {
          const nested = fieldAlias.fields?.[rawPath[2]];
          if (nested?.kind === 'path') return [...nested.path, ...rawPath.slice(3)];
        }
      }
    }

    if (ts.isIdentifier(current)) {
      const alias = aliases.get(current.text);
      if (alias?.kind === 'path') return [...alias.path];
      return alias ? null : [current.text];
    }
    if (ts.isPropertyAccessExpression(current)) {
      const parent = getPathWithAliases(current.expression, aliases);
      return parent ? [...parent, current.name.text] : null;
    }
    if (ts.isElementAccessExpression(current) && current.argumentExpression) {
      const parent = getPathWithAliases(current.expression, aliases);
      if (!parent) return null;
      const key = readLiteral(current.argumentExpression, undefined);
      if (key.ok && (typeof key.value === 'string' || typeof key.value === 'number')) return [...parent, String(key.value)];
      const argument = unwrapExpression(current.argumentExpression);
      if (ts.isIdentifier(argument)) {
        const alias = aliases.get(argument.text);
        if (alias?.kind === 'index') return [...parent, String(alias.index ?? 0)];
        if (alias?.kind === 'key') return [...parent, alias.value];
      }
    }
    return null;
  }

  function getPathAndLiteralWithAliases(left, right, aliases = new Map(), undefinedValue) {
    const leftPath = getPathWithAliases(left, aliases);
    const rightLiteral = readLiteral(right, undefinedValue);
    if (leftPath && rightLiteral.ok) return { path: leftPath, literal: rightLiteral.value, swapped: false };
    const rightPath = getPathWithAliases(right, aliases);
    const leftLiteral = readLiteral(left, undefinedValue);
    if (rightPath && leftLiteral.ok) return { path: rightPath, literal: leftLiteral.value, swapped: true };
    return null;
  }

  function getTwoPathsWithAliases(left, right, aliases = new Map()) {
    const leftPath = getPathWithAliases(left, aliases);
    const rightPath = getPathWithAliases(right, aliases);
    return leftPath && rightPath ? { leftPath, rightPath } : null;
  }

  function createPathAccessNode(pathParts) {
    if (!pathParts?.length) return null;
    let expression = ts.factory.createIdentifier(String(pathParts[0]));
    for (const part of pathParts.slice(1)) {
      expression = /^\d+$/.test(String(part))
        ? ts.factory.createElementAccessExpression(expression, ts.factory.createNumericLiteral(Number(part)))
        : ts.factory.createPropertyAccessExpression(expression, String(part));
    }
    return expression;
  }

  function applyPropertyTail(expression, tail) {
    let current = expression;
    for (const part of tail ?? []) {
      current = /^\d+$/.test(String(part))
        ? ts.factory.createElementAccessExpression(current, ts.factory.createNumericLiteral(Number(part)))
        : ts.factory.createPropertyAccessExpression(current, String(part));
    }
    return current;
  }

  return Object.freeze({
    unwrapExpression,
    readLiteral,
    getPath,
    getPathWithAliases,
    getPathAndLiteralWithAliases,
    getTwoPathsWithAliases,
    createPathAccessNode,
    applyPropertyTail,
  });
}
