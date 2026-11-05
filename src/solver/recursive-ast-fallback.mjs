/**
 * Compatibility adapter for condition shapes not yet fully represented by Constraint IR.
 * All AST and domain operations are injected; this module owns only recursive AST solving policy.
 */
export function createRecursiveAstFallbackAdapter(dependencies) {
  const {
    deriveAnalysisOperationContext, ts, getArrayCallbackDescriptor, getCallbackPredicateExpression, getLoopElementValue,
    withArrayCallbackAliases, getArrayPipelineContext, combineSolutions, cloneJson,
    getPipelineRepresentativeLength, makeAssignment, callbackUsesIdentifier,
    solveFindIndexComparison, solveFindComparison, solveAffineComparison,
    getPathAndLiteralWithAliases, invertRelationalOperator, comparisonAssignment,
    getTwoPathsWithAliases, unsupportedSolution, getPathWithAliases, typeBasedTruthy,
  } = dependencies;

  function solve(current, desired, operationContext, solveCondition) {
    const context = {
      fn: operationContext.function.node,
      sourceFile: operationContext.function.sourceFile,
      checker: operationContext.function.checker,
      parameterMap: operationContext.paths.parameterMap,
      localMockMap: operationContext.paths.localMockMap,
      pathAliases: new Map(operationContext.paths.pathAliases),
      inferredPaths: operationContext.paths.inferredPaths,
      dataFlowModel: operationContext.paths.dataFlowModel,
      maxAlternatives: operationContext.limits.maxAlternatives,
    };
    const maxAlternatives = operationContext.limits.maxAlternatives;
    const solveChild = (child, childDesired, childIncoming = null) => {
      const childContext = deriveAnalysisOperationContext(operationContext, {
        paths: { pathAliases: new Map(context.pathAliases) },
      });
      return solveCondition(child, childDesired, childContext, childIncoming);
    };
  if (ts.isCallExpression(current)) {
    const descriptor = getArrayCallbackDescriptor(current, context);
    if (descriptor && ['some', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex'].includes(descriptor.method) && descriptor.callback) {
      const predicate = getCallbackPredicateExpression(descriptor.callback);
      if (!predicate) return unsupportedSolution(`Cannot extract a simple predicate from ${descriptor.method}() callback.`);
      const itemValue = getLoopElementValue(descriptor.collectionPath, context, current, '0');
      const solveAtIndex = (itemIndex, predicateOutcome) => {
        const restore = withArrayCallbackAliases(descriptor, itemIndex, context, itemIndex);
        try {
          const upstream = getArrayPipelineContext(descriptor, itemIndex, context, itemIndex).filterSolutions;
          return combineSolutions(upstream,
            solveChild(predicate, predicateOutcome, upstream), maxAlternatives);
        } finally { restore(); }
      };
      const makeArray = (length) => Array.from({ length: getPipelineRepresentativeLength(descriptor, length) }, () => cloneJson(itemValue));
      const results = [];

      if (descriptor.method === 'filter') {
        // Arrays are truthy even when empty; this covers `if (items.filter(...))`.
        return desired ? [makeAssignment(descriptor.collectionPath, [])] : [];
      }
      if (descriptor.method === 'some' || descriptor.method === 'find' || descriptor.method === 'findLast') {
        if (desired) {
          results.push(...combineSolutions([makeAssignment(descriptor.collectionPath, makeArray(1))], solveAtIndex(0, true), maxAlternatives));
        } else {
          // Prefer a concrete nonmatching element first (more useful for predicate tests),
          // while retaining the empty-array case as an additional valid scenario.
          results.push(...combineSolutions([makeAssignment(descriptor.collectionPath, makeArray(1))], solveAtIndex(0, false), maxAlternatives));
          results.push(makeAssignment(descriptor.collectionPath, []));
        }
        const callbackUsesIndex = descriptor.callback.parameters?.[1] && ts.isIdentifier(descriptor.callback.parameters[1].name) &&
          callbackUsesIdentifier(descriptor.callback, descriptor.callback.parameters[1].name.text);
        if (desired && callbackUsesIndex) {
          const twoItems = makeArray(2);
          if (descriptor.method === 'findLast') {
            results.push(...combineSolutions([makeAssignment(descriptor.collectionPath, twoItems)], solveAtIndex(1, true), maxAlternatives));
          } else {
            const firstFalse = solveAtIndex(0, false);
            const secondTrue = solveAtIndex(1, true);
            results.push(...combineSolutions([makeAssignment(descriptor.collectionPath, twoItems)], combineSolutions(firstFalse, secondTrue, maxAlternatives), maxAlternatives));
          }
        }
        return results.slice(0, maxAlternatives);
      }
      if (descriptor.method === 'every') {
        const outcome = desired;
        return combineSolutions(
          [makeAssignment(descriptor.collectionPath, makeArray(1))],
          solveAtIndex(0, outcome), maxAlternatives,
        );
      }
      // JavaScript truthiness of findIndex(): -1 and indexes > 0 are truthy, 0 is falsy.
      if (descriptor.method === 'findIndex' || descriptor.method === 'findLastIndex') {
        if (!desired) {
          return combineSolutions([makeAssignment(descriptor.collectionPath, makeArray(1))], solveAtIndex(0, true), maxAlternatives);
        }
        results.push(makeAssignment(descriptor.collectionPath, [])); // result -1
        results.push(...combineSolutions([makeAssignment(descriptor.collectionPath, makeArray(2))],
          combineSolutions(solveAtIndex(0, false), solveAtIndex(1, true), maxAlternatives), maxAlternatives));
        return results.slice(0, maxAlternatives);
      }
    }
  }

  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    return solveChild(current.operand, !desired);
  }
  if (ts.isBinaryExpression(current)) {
    const findIndexSolutions = solveFindIndexComparison(current, desired, context);
    if (findIndexSolutions !== null) return findIndexSolutions;
    const findSolutions = solveFindComparison(current, desired, context);
    if (findSolutions !== null) return findSolutions;
    const op = current.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (desired) return combineSolutions(solveChild(current.left, true), solveChild(current.right, true), maxAlternatives);
      const leftFalse = solveChild(current.left, false);
      const leftTrueRightFalse = combineSolutions(solveChild(current.left, true), solveChild(current.right, false), maxAlternatives);
      return [...leftFalse, ...leftTrueRightFalse].slice(0, maxAlternatives);
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      if (!desired) return combineSolutions(solveChild(current.left, false), solveChild(current.right, false), maxAlternatives);
      const leftTrue = solveChild(current.left, true);
      const leftFalseRightTrue = combineSolutions(solveChild(current.left, false), solveChild(current.right, true), maxAlternatives);
      return [...leftTrue, ...leftFalseRightTrue].slice(0, maxAlternatives);
    }
    if ([
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ].includes(op)) {
      const affineSolutions = solveAffineComparison(current, desired, context);
      if (affineSolutions !== null && affineSolutions.length) return affineSolutions;
      const pair = getPathAndLiteralWithAliases(current.left, current.right, context.pathAliases);
      if (pair) {
        const normalizedOp = pair.swapped ? invertRelationalOperator(op) : op;
        return comparisonAssignment(pair.path, pair.literal, normalizedOp, desired, context.parameterMap, context.localMockMap, context.checker, current, context.inferredPaths);
      }
      const paths = getTwoPathsWithAliases(current.left, current.right, context.pathAliases);
      if (paths && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(op)) {
        // Keep multiple representative assignments where possible. In particular,
        // a strict comparison being false can also mean equality; retaining that
        // candidate is necessary for sequential comparator branches such as
        // `if (a < b) ...; if (a === b) ...`.
        let candidates;
        if (op === ts.SyntaxKind.LessThanToken) candidates = desired ? [[0, 1]] : [[1, 0], [0, 0]];
        else if (op === ts.SyntaxKind.LessThanEqualsToken) candidates = desired ? [[0, 0], [0, 1]] : [[1, 0]];
        else if (op === ts.SyntaxKind.GreaterThanToken) candidates = desired ? [[1, 0]] : [[0, 1], [0, 0]];
        else if (op === ts.SyntaxKind.GreaterThanEqualsToken) candidates = desired ? [[0, 0], [1, 0]] : [[0, 1]];
        else if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken) candidates = desired ? [[0, 0]] : [[0, 1], [1, 0]];
        else candidates = desired ? [[0, 1], [1, 0]] : [[0, 0]];
        return candidates.map(([leftValue, rightValue]) => combineSolutions(
          [makeAssignment(paths.leftPath, leftValue)],
          [makeAssignment(paths.rightPath, rightValue)],
          maxAlternatives,
        )[0]).filter(Boolean);
      }
      return unsupportedSolution(`Unsupported comparison: ${current.getText(context.sourceFile)}`);
    }
  }
  const pathParts = getPathWithAliases(current, context.pathAliases);
  if (pathParts) return [typeBasedTruthy(pathParts, desired, context.parameterMap, context.localMockMap, context.checker, current, context.inferredPaths)];
  if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
    const actual = current.kind === ts.SyntaxKind.TrueKeyword;
    return actual === desired ? [{ assignments: new Map(), unsupported: [] }] : [];
  }
  return unsupportedSolution(`Unsupported condition expression: ${current.getText(context.sourceFile)}`);
  }

  return Object.freeze({ solve });
}
