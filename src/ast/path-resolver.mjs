/**
 * TypeScript AST path utilities. This adapter composes AstFacade primitives
 * with function-local alias/constant discovery; it does not inspect types.
 */
export function createPathResolver({ ts, astFacade, undefinedValue = undefined }) {
  if (!ts || !astFacade) throw new TypeError('PathResolver requires TypeScript and AstFacade.');
  const {
    unwrapExpression, readLiteral, getPath, getPathWithAliases,
    getPathAndLiteralWithAliases, getTwoPathsWithAliases,
    createPathAccessNode, applyPropertyTail,
  } = astFacade;

  function collectLocalPathAliases(functionNode) {
    const aliases = new Map();
    const root = functionNode?.node ?? functionNode;
    if (!root?.body) return aliases;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const path = getPath(node.initializer);
        if (path) aliases.set(node.name.text, { kind: 'path', path });
      }
      ts.forEachChild(node, visit);
    }
    visit(root.body);
    return aliases;
  }

  function collectLocalNumericConstants(functionNode) {
    const constants = new Map();
    const root = functionNode?.node ?? functionNode;
    if (!root?.body) return constants;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const literal = readLiteral(node.initializer, undefinedValue);
        if (literal.ok && typeof literal.value === 'number') constants.set(node.name.text, literal.value);
      }
      ts.forEachChild(node, visit);
    }
    visit(root.body);
    return constants;
  }

  function getLoopVariableName(initializer) {
    if (!initializer) return null;
    if (ts.isVariableDeclarationList(initializer)) {
      const declaration = initializer.declarations[0];
      return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
    }
    if (ts.isBinaryExpression(initializer) && initializer.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(initializer.left)) {
      return initializer.left.text;
    }
    return null;
  }

  function getLoopInitialValue(initializer, variableName) {
    if (!initializer || !variableName) return { ok: false };
    if (ts.isVariableDeclarationList(initializer)) {
      const declaration = initializer.declarations[0];
      return declaration?.initializer ? readLiteral(declaration.initializer, undefinedValue) : { ok: false };
    }
    if (ts.isBinaryExpression(initializer) && ts.isIdentifier(initializer.left) && initializer.left.text === variableName) {
      return readLiteral(initializer.right, undefinedValue);
    }
    return { ok: false };
  }

  function findLengthCollectionPath(node, aliases = new Map()) {
    let found = null;
    function visit(current) {
      if (!current || found) return;
      if (ts.isPropertyAccessExpression(current) && current.name.text === 'length') {
        const path = getPathWithAliases(current.expression, aliases);
        if (path) { found = path; return; }
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    return found;
  }

  function isComparisonOperator(kind) {
    return [
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ].includes(kind);
  }

  function makeLiteralNode(value) {
    if (value === null) return ts.factory.createNull();
    if (value === true) return ts.factory.createTrue();
    if (value === false) return ts.factory.createFalse();
    if (typeof value === 'number') return value < 0
      ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(Math.abs(value)))
      : ts.factory.createNumericLiteral(value);
    if (typeof value === 'string') return ts.factory.createStringLiteral(value);
    return null;
  }

  function substituteIdentifier(node, name, literalValue) {
    const replacement = makeLiteralNode(literalValue);
    if (!replacement) return node;
    const transformed = ts.transform(node, [context => root => {
      const visit = current => {
        if (ts.isIdentifier(current) && current.text === name &&
            !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)) {
          return makeLiteralNode(literalValue);
        }
        return ts.visitEachChild(current, visit, context);
      };
      return ts.visitNode(root, visit);
    }]);
    const result = transformed.transformed[0];
    transformed.dispose();
    return result;
  }

  function substituteIdentifiers(node, replacements) {
    let result = node;
    for (const [name, value] of replacements) result = substituteIdentifier(result, name, value);
    return result;
  }

  function substituteKnownAliases(node, aliases, depth = 0) {
    if (!node || !aliases?.size || depth > 8) return node;
    const transformed = ts.transform(node, [context => root => {
      const visit = current => {
        const rawPath = getPath(current);
        if (rawPath?.length) {
          const rootAlias = aliases.get(rawPath[0]);
          if (rootAlias?.kind === 'path') {
            return createPathAccessNode([...rootAlias.path, ...rawPath.slice(1)]) ?? current;
          }
          if (rootAlias?.kind === 'constant') {
            let value = rootAlias.value;
            for (const part of rawPath.slice(1)) value = value == null ? undefined : value[part];
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return makeLiteralNode(value) ?? current;
          }
          if (rootAlias?.kind === 'object' && rawPath.length > 1) {
            let field = rootAlias.fields?.[rawPath[1]];
            let rest = rawPath.slice(2);
            if (field?.kind === 'path') return createPathAccessNode([...field.path, ...rest]) ?? current;
            if (field?.kind === 'constant') {
              let value = field.value;
              for (const part of rest) value = value == null ? undefined : value[part];
              if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return makeLiteralNode(value) ?? current;
            }
            if (field?.kind === 'computed' && field.expression) {
              let replacement = substituteKnownAliases(field.expression, field.aliases ?? new Map(), depth + 1);
              if (rest.length) replacement = applyPropertyTail(replacement, rest);
              return replacement;
            }
            if (field?.kind === 'object' && rest.length) {
              field = field.fields?.[rest[0]];
              rest = rest.slice(1);
              if (field?.kind === 'path') return createPathAccessNode([...field.path, ...rest]) ?? current;
              if (field?.kind === 'constant') {
                let value = field.value;
                for (const part of rest) value = value == null ? undefined : value[part];
                if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return makeLiteralNode(value) ?? current;
              }
              if (field?.kind === 'computed' && field.expression) {
                let replacement = substituteKnownAliases(field.expression, field.aliases ?? new Map(), depth + 1);
                if (rest.length) replacement = applyPropertyTail(replacement, rest);
                return replacement;
              }
            }
          }
        }
        if (ts.isIdentifier(current)) {
          const alias = aliases.get(current.text);
          if (alias?.kind === 'constant' && alias.value !== undefined) return makeLiteralNode(alias.value) ?? current;
          if (alias?.kind === 'path') return createPathAccessNode(alias.path) ?? current;
        }
        return ts.visitEachChild(current, visit, context);
      };
      return ts.visitNode(root, visit);
    }]);
    const result = transformed.transformed[0];
    transformed.dispose();
    return result;
  }

  return Object.freeze({
    unwrapExpression, readLiteral, getPath, getPathWithAliases, getPathAndLiteralWithAliases,
    getTwoPathsWithAliases, createPathAccessNode, applyPropertyTail,
    collectLocalPathAliases, collectLocalNumericConstants,
    getLoopVariableName, getLoopInitialValue, findLengthCollectionPath, isComparisonOperator,
    makeLiteralNode, substituteIdentifier, substituteIdentifiers, substituteKnownAliases,
  });
}
