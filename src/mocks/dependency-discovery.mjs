import { createCallSiteIdentity } from './call-identity.mjs';

/** TypeScript AST adapter for discovering local values backed by dependency calls. */
function sourceSpan(sourceFile, node, fileName) {
  const startOffset = node.getStart(sourceFile);
  const endOffset = node.getEnd();
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(endOffset);
  return {
    file: fileName ?? sourceFile.fileName,
    startOffset,
    endOffset,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}


function argumentFact(argument, index, checker, ts, sourceFile) {
  let current = argument;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))) current = current.expression;
  const expressionText = argument.getText(sourceFile);
  if (current && (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) || current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword || current.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(current) && current.text === 'undefined'))) {
    const value = ts.isStringLiteralLike(current) ? current.text
      : ts.isNumericLiteral(current) ? Number(current.text)
      : current.kind === ts.SyntaxKind.TrueKeyword ? true
      : current.kind === ts.SyntaxKind.FalseKeyword ? false
      : current.kind === ts.SyntaxKind.NullKeyword ? null
      : { $undefined: true };
    return { index, kind: 'literal', expressionText, value, confidence: 'high' };
  }
  if (current && ts.isPrefixUnaryExpression(current) && ts.isNumericLiteral(current.operand) &&
      (current.operator === ts.SyntaxKind.MinusToken || current.operator === ts.SyntaxKind.PlusToken)) {
    return { index, kind: 'literal', expressionText, value: Number(current.operand.text) * (current.operator === ts.SyntaxKind.MinusToken ? -1 : 1), confidence: 'high' };
  }
  const segments = [];
  let root = current;
  while (root && (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))) {
    if (ts.isPropertyAccessExpression(root)) segments.unshift(root.name.text);
    else if (root.argumentExpression && (ts.isStringLiteralLike(root.argumentExpression) || ts.isNumericLiteral(root.argumentExpression))) segments.unshift(String(root.argumentExpression.text));
    else return { index, kind: 'dynamic-path', expressionText, confidence: 'low' };
    root = root.expression;
  }
  if (root && ts.isIdentifier(root)) {
    let symbol = null;
    try { symbol = checker?.getSymbolAtLocation?.(root) ?? null; } catch { /* Optional checker metadata. */ }
    return { index, kind: 'path', expressionText, path: [root.text, ...segments], confidence: symbol ? 'high' : 'medium' };
  }
  return { index, kind: 'expression', expressionText, confidence: 'low' };
}

export function createDependencyDiscovery(ts) {
  if (!ts) throw new TypeError('DependencyDiscovery requires an injected TypeScript API.');

  function isNestedFunction(node, root) {
    return node !== root && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) || ts.isMethodDeclaration?.(node));
  }

  function isMockableExternalCall(callExpression, input) {
    const callText = callExpression.expression?.getText?.() ?? '';
    const overrides = input.mockBehaviorOverrides ?? {};
    // An explicit user override is authoritative, including for a project-local
    // helper. Project functions are never mocked merely because a summary is
    // unavailable; users can still deliberately replace them for a test.
    if (Object.prototype.hasOwnProperty.call(overrides, callText)) return true;
    const identity = input.callIdentityForNode?.(callExpression);
    if (identity?.callSiteId && Object.prototype.hasOwnProperty.call(overrides, identity.callSiteId)) return true;
    if (!input.functionIndex) return true;
    return input.functionIndex.classifyCall(callExpression)?.kind === 'external-dependency';
  }

  function discoverLocalMockBindings(input) {
    const { functionNode, checker, sourceFile } = input;
    const unwrap = input.unwrap ?? (node => node);
    const bindings = new Map();
    if (!functionNode?.body) return bindings;

    function visit(node) {
      if (isNestedFunction(node, functionNode)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let initializer = unwrap(node.initializer);
        const wasAwaited = Boolean(initializer && ts.isAwaitExpression(initializer));
        if (wasAwaited) initializer = unwrap(initializer.expression);
        if (initializer && ts.isCallExpression(initializer) && isMockableExternalCall(initializer, input)) {
          const callType = checker.getTypeAtLocation(initializer);
          let resolvedType = callType;
          let isPromise = false;
          try {
            const promised = checker.getPromisedTypeOfPromise(callType);
            if (promised) { resolvedType = promised; isPromise = true; }
          } catch { /* Non-Promise and unsupported thenable types remain synchronous. */ }
          // An un-awaited Promise object is always truthy; its resolved value is
          // not the value observed by a branch on the local variable.
          if (!isPromise || wasAwaited) {
            const callExpression = initializer.expression.getText(sourceFile);
            const span = sourceSpan(sourceFile, initializer, input.relativeFile);
            const identity = createCallSiteIdentity({
              relativeFile: span.file, startOffset: span.startOffset, endOffset: span.endOffset, callExpression,
            });
            bindings.set(node.name.text, {
              localName: node.name.text,
              call: callExpression,
              ...identity,
              resolvedType,
              isPromise,
              awaited: wasAwaited,
              sourceSpan: span,
              argumentFacts: initializer.arguments.map((argument, index) => argumentFact(argument, index, checker, ts, sourceFile)),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(functionNode.body);
    return bindings;
  }

  function enclosingFunction(node, root) {
    for (let current = node.parent; current && current !== root; current = current.parent) {
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) ||
          ts.isArrowFunction(current) || ts.isMethodDeclaration?.(current)) return current;
    }
    return root;
  }

  function functionScopeName(node, sourceFile) {
    if (node.name) return node.name.getText(sourceFile);
    const parent = node.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration?.(parent))) {
      return parent.name?.getText?.(sourceFile) ?? '<anonymous>';
    }
    return '<inline-callback>';
  }

  function discoverCallSites(input) {
    const { functionNode, checker, sourceFile } = input;
    const sites = [];
    const seen = new Set();
    if (!functionNode?.body) return sites;
    function visit(node) {
      // Enter nested declarations and callbacks: local functions aren't mocked,
      // but external calls inside their bodies still need to be documented.
      if (ts.isCallExpression(node) && isMockableExternalCall(node, input)) {
        const callExpression = node.expression.getText(sourceFile);
        const span = sourceSpan(sourceFile, node, input.relativeFile);
        const identity = createCallSiteIdentity({
          relativeFile: span.file, startOffset: span.startOffset, endOffset: span.endOffset, callExpression,
        });
        const { callSiteId } = identity;
        if (!seen.has(callSiteId)) {
          seen.add(callSiteId);
          const returnType = checker.getTypeAtLocation(node);
          let resolvedType = returnType;
          let isPromise = false;
          try {
            const promised = checker.getPromisedTypeOfPromise(returnType);
            if (promised) { resolvedType = promised; isPromise = true; }
          } catch { /* Keep the declared return type. */ }
          const owner = enclosingFunction(node, functionNode);
          const classification = input.functionIndex?.classifyCall?.(node) ?? { kind: 'external-dependency', confidence: 'low', source: 'missing-function-index' };
          sites.push({
            ...identity,
            returnType,
            resolvedType,
            isPromise,
            node,
            sourceSpan: span,
            classification,
            nested: owner !== functionNode,
            functionScope: functionScopeName(owner, sourceFile),
            executionContext: owner === functionNode ? 'function-body' : 'nested-function-body',
            reachability: owner === functionNode ? 'direct-static-call-site' : 'nested-invocation-not-proven',
            argumentFacts: node.arguments.map((argument, index) => argumentFact(argument, index, checker, ts, sourceFile)),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(functionNode.body);
    return sites;
  }

  return Object.freeze({ discoverLocalMockBindings, discoverCallSites });
}
