/**
 * Collect immutable local expression facts for the TypeScript front-end.
 *
 * This module deliberately returns compiler-side references only. Callers must
 * lower them to JSON-safe Constraint IR before crossing the solver boundary.
 */
function stableSymbolId(symbol) {
  if (!symbol) return null;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  let start = -1;
  try { start = declaration?.name?.getStart?.() ?? declaration?.getStart?.() ?? -1; } catch { /* synthetic symbol */ }
  return `${start}:${symbol.getName?.() ?? 'anonymous'}`;
}

function unwrap(node, ts) {
  let current = node;
  while (current && (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression?.(current)
  )) current = current.expression;
  return current;
}

function isNumericLiteral(node, ts) {
  const current = unwrap(node, ts);
  if (!current) return false;
  if (ts.isNumericLiteral(current)) return true;
  return ts.isPrefixUnaryExpression(current) &&
    [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(current.operator) &&
    ts.isNumericLiteral(current.operand);
}


function isSafeSsaAliasExpression(node, ts) {
  const current = unwrap(node, ts);
  if (!current) return false;
  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) return true;
  if (ts.isElementAccessExpression(current)) {
    const argument = unwrap(current.argumentExpression, ts);
    return Boolean(argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) && isSafeSsaAliasExpression(current.expression, ts));
  }
  return ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(current) && current.text === 'undefined');
}

function buildSsaUseAliases(functionNode, ts, checker, sourceFile, versioned) {
  const byStart = new Map();
  const parameterNodes = new Map();
  const visit = node => {
    if (!node) return;
    if (node !== functionNode && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) return;
    const start = node.getStart?.(sourceFile);
    if (Number.isInteger(start)) {
      const list = byStart.get(start) ?? [];
      list.push(node);
      byStart.set(start, list);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const symbol = checker?.getSymbolAtLocation(node.name);
      if (symbol) parameterNodes.set(stableSymbolId(symbol), node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode);

  const definitions = new Map((versioned?.definitions ?? []).map(item => [item.id, item]));
  const phis = new Map((versioned?.phiNodes ?? []).map(item => [item.output, item]));
  const resolveVersion = (id, seen = new Set(), depth = 0) => {
    if (!id || depth > 16 || seen.has(id)) return null;
    const definition = definitions.get(id);
    if (definition) {
      if (definition.kind === 'parameter') return parameterNodes.get(definition.symbolId) ?? null;
      const span = definition.sourceSpan;
      if (!span || !Number.isInteger(span.startOffset)) return null;
      const candidates = byStart.get(span.startOffset) ?? [];
      const expression = candidates.find(node => node.getEnd?.() === span.endOffset) ?? candidates.find(node => node.getEnd?.() <= span.endOffset);
      return expression && isSafeSsaAliasExpression(expression, ts) ? expression : null;
    }
    const phi = phis.get(id);
    if (!phi || !phi.complete || !phi.inputs.length) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const resolved = phi.inputs.map(input => resolveVersion(input.value, nextSeen, depth + 1));
    if (resolved.some(value => !value)) return null;
    const canonical = node => {
      const text = node.getText?.(sourceFile) ?? '';
      return text.replace(/\s+/g, '');
    };
    return resolved.every(item => canonical(item) === canonical(resolved[0])) ? resolved[0] : null;
  };

  const aliases = new Map();
  for (const binding of versioned?.useBindings ?? []) {
    if (!binding.value || !binding.occurrences?.length) continue;
    const expression = resolveVersion(binding.value);
    if (!expression) continue;
    for (const occurrence of binding.occurrences) {
      aliases.set(`${binding.symbolId}:${occurrence.startOffset}`, expression);
    }
  }
  return aliases;
}

function isSupportedValueExpression(node, ts, checker, seenSymbols = new Set(), depth = 0) {
  if (!node || depth > 12) return false;
  const current = unwrap(node, ts);
  if (!current) return false;
  if (isNumericLiteral(current, ts) || current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword || current.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(current) && current.text === 'undefined')) return true;

  if (ts.isIdentifier(current)) {
    const symbol = checker?.getSymbolAtLocation(current);
    if (!symbol || seenSymbols.has(symbol)) return false;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    // Parameters, callback parameters and externally supplied roots are symbolic
    // input paths. They are not inlined or evaluated by the data-flow adapter.
    if (declaration && ts.isParameter(declaration)) return true;
    if (!declaration || !ts.isVariableDeclaration(declaration) ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
    if (!declaration.initializer) return false;
    let initializer = unwrap(declaration.initializer, ts);
    if (initializer && ts.isAwaitExpression(initializer)) initializer = unwrap(initializer.expression, ts);
    // An awaited method result is a symbolic mock root. Keep its local name
    // intact so Scenario materialization can create MockAction values.
    if (initializer && ts.isCallExpression(initializer)) {
      const wasAwaited = ts.isAwaitExpression(unwrap(declaration.initializer, ts));
      try {
        const callType = checker?.getTypeAtLocation(initializer);
        const promised = callType && checker?.getPromisedTypeOfPromise(callType);
        if (promised && !wasAwaited) return false;
      } catch { /* Unknown thenables are not expanded as mock results. */ }
      return true;
    }
    const nested = new Set(seenSymbols);
    nested.add(symbol);
    return isSupportedValueExpression(declaration.initializer, ts, checker, nested, depth + 1);
  }

  if (ts.isPropertyAccessExpression(current)) {
    return isSupportedValueExpression(current.expression, ts, checker, seenSymbols, depth + 1);
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    return isSupportedValueExpression(current.expression, ts, checker, seenSymbols, depth + 1) &&
      (ts.isStringLiteralLike(current.argumentExpression) || isNumericLiteral(current.argumentExpression, ts));
  }
  if (ts.isPrefixUnaryExpression(current) &&
      [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(current.operator)) {
    return isSupportedValueExpression(current.operand, ts, checker, seenSymbols, depth + 1);
  }
  if (ts.isBinaryExpression(current) && [
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
  ].includes(current.operatorToken.kind)) {
    // `+` is accepted only when TypeScript confirms numeric semantics; otherwise
    // JavaScript string concatenation would be silently mis-modelled.
    if (current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (!checker) return false;
      const type = checker.getTypeAtLocation(current);
      if (!(type.flags & ts.TypeFlags.NumberLike)) return false;
    }
    return isSupportedValueExpression(current.left, ts, checker, seenSymbols, depth + 1) &&
      isSupportedValueExpression(current.right, ts, checker, seenSymbols, depth + 1);
  }
  return false;
}

/**
 * Build symbol-keyed immutable aliases and mock-bound local facts.
 *
 * `expressionAliases` maps TypeScript symbols to initializer AST nodes for
 * expressions that can be safely lowered into numeric/path/literal IR.
 * `mockBindings` identifies local variables assigned from direct calls (or
 * awaited calls); their symbolic paths remain rooted at the local name so the
 * existing scenario materializer can route assignments into MockAction DTOs.
 */
export function collectTypescriptExpressionFacts(functionNode, ts, checker, sourceFile, options = {}) {
  const expressionAliases = new Map();
  const mockBindings = new Map();
  const expressionFacts = [];
  const mockBindingFacts = [];
  const symbolKey = symbol => options.projectFunctionIndex?.symbolIdForSymbol?.(symbol) ?? stableSymbolId(symbol);
  const localSummaries = new Map((options.functionSummaries ?? []).filter(item => item.symbolId).map(item => [item.symbolId, item]));
  const returnFacts = new Map((options.returnValueFacts ?? []).map(item => [item.callId, item]));
  const ssaUseAliases = buildSsaUseAliases(functionNode, ts, checker, sourceFile, options.ssaVersioned);
  const toSourceSpan = node => {
    const start = node.getStart(sourceFile);
    const end = node.end;
    const startPos = sourceFile.getLineAndCharacterOfPosition(start);
    const endPos = sourceFile.getLineAndCharacterOfPosition(end);
    return {
      file: options.fileName ?? sourceFile.fileName, startOffset: start, endOffset: end,
      startLine: startPos.line + 1, startColumn: startPos.character + 1,
      endLine: endPos.line + 1, endColumn: endPos.character + 1,
    };
  };
  if (!functionNode?.body) return { expressionAliases, mockBindings, expressionFacts, mockBindingFacts };

  const visit = node => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (node !== functionNode) return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      const symbol = checker?.getSymbolAtLocation(node.name);
      if (symbol) {
        let initializer = unwrap(node.initializer, ts);
        const awaited = Boolean(initializer && ts.isAwaitExpression(initializer));
        if (awaited) initializer = unwrap(initializer.expression, ts);
        if (initializer && ts.isCallExpression(initializer)) {
          const call = initializer.expression.getText(sourceFile);
          const calleeSymbol = checker?.getSymbolAtLocation(initializer.expression);
          const localSummary = calleeSymbol ? localSummaries.get(symbolKey(calleeSymbol)) : null;
          const callId = `call:${initializer.getStart(sourceFile)}`;
          const returnFact = returnFacts.get(callId);
          const overrides = options.mockBehaviorOverrides ?? {};
          const explicitOverride = Object.prototype.hasOwnProperty.call(overrides, call);
          const callClassification = explicitOverride
            ? { kind: 'external-dependency', confidence: 'explicit-mock-override' }
            : options.classifyCall?.(initializer) ?? { kind: 'external-dependency', confidence: 'low' };
          if (localSummary) {
            // A local helper call is not a mock. Only a single, pure,
            // parameter-substituted path return is safe to expose as a path alias.
            if (localSummary.purity === 'pure' && returnFact?.usableAsConstraintAlias && returnFact.values?.length === 1) {
              const value = returnFact.values[0];
              expressionAliases.set(symbol, { kind: 'constraint-path', path: [...value.path], callId, functionId: localSummary.functionId });
              expressionFacts.push({
                kind: 'interprocedural-return-alias', alias: node.name.text,
                expressionText: node.initializer.getText(sourceFile), dependencies: [value.expression], immutable: true,
                callId, targetFunctionId: localSummary.functionId, resolvedPath: [...value.path],
                sourceSpan: toSourceSpan(node.initializer), confidence: 'high',
              });
            }
          } else if (callClassification.kind === 'pure-intrinsic') {
            expressionFacts.push({
              kind: 'pure-intrinsic-call', localName: node.name.text, callExpression: call,
              immutable: true, confidence: 'high', sourceSpan: toSourceSpan(node.initializer),
            });
          } else if (callClassification.kind === 'external-dependency') {
            mockBindings.set(symbol, { kind: 'mock-call', localName: node.name.text, call, awaited });
            let isPromise = false;
            try { isPromise = Boolean(checker?.getPromisedTypeOfPromise(checker.getTypeAtLocation(initializer))); }
            catch { /* Treat an unknown thenable conservatively as a non-promise call. */ }
            if (!isPromise || awaited) mockBindingFacts.push({
              kind: 'mock-call', localName: node.name.text, callExpression: call, awaited,
              classification: 'external-dependency', sourceSpan: toSourceSpan(node.initializer),
            });
          } else {
            // A project-local or unresolved call must not be silently replaced
            // by a Jest mock. Keep an opaque fact so downstream generation can
            // report the limitation without bypassing application code.
            expressionFacts.push({
              kind: 'opaque-call', localName: node.name.text, callExpression: call,
              classification: callClassification.kind, immutable: false,
              confidence: 'low', sourceSpan: toSourceSpan(node.initializer),
            });
          }
        } else if (isSupportedValueExpression(node.initializer, ts, checker, new Set([symbol]))) {
          expressionAliases.set(symbol, node.initializer);
          const dependencies = new Set();
          const isAccess = current => ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current);
          const collectDependencies = current => {
            if (isAccess(current)) {
              const root = current;
              let parent = current.parent;
              while (parent && isAccess(parent) && parent.expression === current) parent = parent.parent;
              if (!parent || !isAccess(parent) || parent.expression !== current) {
                const text = root.getText(sourceFile);
                if (text) dependencies.add(text);
                return;
              }
            }
            if (ts.isIdentifier(current) && current !== node.name &&
                !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)) {
              const dependency = checker?.getSymbolAtLocation(current);
              if (dependency && dependency !== symbol) dependencies.add(dependency.getName());
            }
            ts.forEachChild(current, collectDependencies);
          };
          collectDependencies(node.initializer);
          expressionFacts.push({
            kind: 'immutable-expression', alias: node.name.text,
            expressionText: node.initializer.getText(sourceFile),
            dependencies: [...dependencies].sort(), immutable: true,
            sourceSpan: toSourceSpan(node.initializer),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);

  return { expressionAliases, mockBindings, expressionFacts, mockBindingFacts, ssaUseAliases };
}

/** Resolve an identifier symbol to its immutable initializer, if safe. */
export function createExpressionAliasResolver(facts, checker) {
  return identifier => {
    const symbol = checker?.getSymbolAtLocation(identifier);
    if (!symbol) return null;
    const start = identifier?.getStart?.();
    const ssaAlias = Number.isInteger(start) ? facts?.ssaUseAliases?.get(`${stableSymbolId(symbol)}:${start}`) : null;
    return ssaAlias ?? facts?.expressionAliases?.get(symbol) ?? null;
  };
}
