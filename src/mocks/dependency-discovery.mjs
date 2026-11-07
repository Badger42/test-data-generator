import { createCallSiteIdentity } from './call-identity.mjs';
import { createMockTargetResolver } from './mock-target-resolver.mjs';

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

  const mockTargetResolver = createMockTargetResolver(ts);

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
              mockTarget: mockTargetResolver.resolve(initializer, { ...input, functionNode }),
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

    // Give direct dependency results a synthetic local root so Constraint IR can
    // solve expressions such as await api.isActive(id) and api.getUser(id).active.
    // Existing variable bindings keep their local name and are not duplicated.
    const knownCallSites = new Set([...bindings.values()].map(binding => binding.callSiteId));
    function registerDirectCallResults(node) {
      if (isNestedFunction(node, functionNode)) return;
      if (ts.isCallExpression(node) && isMockableExternalCall(node, input)) {
        const callExpression = node.expression.getText(sourceFile);
        const span = sourceSpan(sourceFile, node, input.relativeFile);
        const identity = createCallSiteIdentity({
          relativeFile: span.file, startOffset: span.startOffset, endOffset: span.endOffset, callExpression,
        });
        if (!knownCallSites.has(identity.callSiteId)) {
          const callType = checker.getTypeAtLocation(node);
          let resolvedType = callType;
          let isPromise = false;
          try {
            const promised = checker.getPromisedTypeOfPromise(callType);
            if (promised) { resolvedType = promised; isPromise = true; }
          } catch { /* Keep the declared return type. */ }
          const awaited = ts.isAwaitExpression(node.parent) && node.parent.expression === node;
          // An un-awaited Promise is truthy regardless of its eventual result.
          if (!isPromise || awaited) {
            const localName = '__bsg_call_result_' + span.startOffset + '_' + span.endOffset;
            bindings.set(localName, {
              localName,
              call: callExpression,
              ...identity,
              mockTarget: mockTargetResolver.resolve(node, { ...input, functionNode }),
              resolvedType,
              isPromise,
              awaited,
              directExpression: true,
              sourceSpan: span,
              argumentFacts: node.arguments.map((argument, index) => argumentFact(argument, index, checker, ts, sourceFile)),
            });
            knownCallSites.add(identity.callSiteId);
          }
        }
      }
      ts.forEachChild(node, registerDirectCallResults);
    }
    registerDirectCallResults(functionNode.body);
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

  function isWithin(ancestor, descendant) {
    for (let current = descendant; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function executionGuards(node, root, sourceFile) {
    const guards = [];
    for (let current = node; current && current !== root; current = current.parent) {
      const parent = current.parent;
      if (!parent) break;
      if (ts.isIfStatement(parent)) {
        const expected = isWithin(parent.thenStatement, node) ? true
          : parent.elseStatement && isWithin(parent.elseStatement, node) ? false : null;
        if (expected !== null) {
          const span = sourceSpan(sourceFile, parent.expression);
          guards.push({
            kind: 'if',
            expressionNode: parent.expression,
            expressionText: parent.expression.getText(sourceFile),
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            expected,
          });
        }
      } else if (ts.isConditionalExpression(parent)) {
        const expected = isWithin(parent.whenTrue, node) ? true
          : isWithin(parent.whenFalse, node) ? false : null;
        if (expected !== null) {
          const span = sourceSpan(sourceFile, parent.condition);
          guards.push({
            kind: 'conditional',
            expressionNode: parent.condition,
            expressionText: parent.condition.getText(sourceFile),
            startOffset: span.startOffset,
            endOffset: span.endOffset,
            expected,
          });
        }
      }
    }
    return guards.reverse();
  }

  function isAlwaysAbrupt(statement) {
    if (!statement) return false;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) if (isAlwaysAbrupt(child)) return true;
      return false;
    }
    if (ts.isIfStatement(statement)) {
      return Boolean(statement.elseStatement) &&
        isAlwaysAbrupt(statement.thenStatement) &&
        isAlwaysAbrupt(statement.elseStatement);
    }
    return false;
  }

  function fallthroughGuards(node, root, sourceFile) {
    const guards = [];
    for (let current = node; current && current !== root; current = current.parent) {
      const container = current.parent;
      if (!container || !ts.isBlock(container)) continue;
      let statement = current;
      while (statement.parent && statement.parent !== container) statement = statement.parent;
      const index = container.statements.indexOf(statement);
      if (index <= 0) continue;

      for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
        const prior = container.statements[priorIndex];
        if (isAlwaysAbrupt(prior)) return { guards, unreachable: true };
        if (!ts.isIfStatement(prior)) continue;

        const thenAbrupt = isAlwaysAbrupt(prior.thenStatement);
        const elseAbrupt = isAlwaysAbrupt(prior.elseStatement);
        if (thenAbrupt && elseAbrupt) return { guards, unreachable: true };
        const expected = thenAbrupt ? false : elseAbrupt ? true : null;
        if (expected === null) continue;

        const span = sourceSpan(sourceFile, prior.expression);
        guards.push({
          kind: 'fallthrough',
          expressionNode: prior.expression,
          expressionText: prior.expression.getText(sourceFile),
          startOffset: span.startOffset,
          endOffset: span.endOffset,
          expected,
        });
      }
    }
    const unique = new Map();
    for (const guard of guards) unique.set(`${guard.startOffset}:${guard.endOffset}:${guard.expected}`, guard);
    return { guards: [...unique.values()], unreachable: false };
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
          const fallthrough = owner === functionNode
            ? fallthroughGuards(node, functionNode, sourceFile)
            : { guards: [], unreachable: false };
          sites.push({
            ...identity,
            returnType,
            resolvedType,
            isPromise,
            node,
            sourceSpan: span,
            classification,
            mockTarget: mockTargetResolver.resolve(node, { ...input, functionNode }),
            nested: owner !== functionNode,
            functionScope: functionScopeName(owner, sourceFile),
            executionContext: owner === functionNode ? 'function-body' : 'nested-function-body',
            reachability: owner === functionNode ? 'direct-static-call-site' : 'nested-invocation-not-proven',
            // A nested function may be invoked through an alias or after the
            // lexical branch that created it. Its body is therefore not
            // constrained by the surrounding declaration-site path.
            executionGuards: owner === functionNode
              ? [...executionGuards(node, functionNode, sourceFile), ...fallthrough.guards]
              : [],
            invocationStatus: owner !== functionNode ? 'nested-invocation-not-proven'
              : fallthrough.unreachable ? 'not-invoked' : 'conditional-or-reachable',
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
