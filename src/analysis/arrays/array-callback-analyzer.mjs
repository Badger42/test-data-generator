import {
  ARRAY_PREDICATE_METHODS,
  ARRAY_COMPARATOR_METHODS,
  ARRAY_SEARCH_METHODS,
  getCallbackCardinalityVariants,
  getCallbackIterationIndices,
} from '../../domain/array-method-policy.mjs';

/** Walks callback expressions and array chains without deciding scenario semantics. */
export function createCallbackTraversal({ ts, getDescriptor, unwrap, dispatchCall }) {
  function analyzeInNode(node, incoming, ctx) {
    function visit(current) {
      if (!current) return;
      if (ts.isCallExpression(current)) {
        const descriptor = getDescriptor(current, ctx);
        if (descriptor) {
          dispatchCall(current, incoming, ctx);
          const refreshed = getDescriptor(current, ctx);
          const expression = unwrap(current.expression);
          if (expression && ts.isPropertyAccessExpression(expression)) visit(expression.expression);
          if (refreshed) visit(refreshed.callback.body);
          for (const argument of current.arguments) if (argument !== refreshed?.callback) visit(argument);
          return;
        }
      }
      if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) return;
      ts.forEachChild(current, visit);
    }
    visit(node);
  }
  return Object.freeze({ analyzeInNode });
}

/**
 * Owns callback traversal, method dispatch, representative iteration planning,
 * callback alias scoping, and nested callback orchestration.
 *
 * AST readers, solver operations and scenario emission are narrow injected
 * ports. The module itself has no dependency on the runtime composition, TypeScript
 * package loading, Jest, filesystem or report serialization.
 */
export function createArrayCallbackAnalyzer(ports) {
  const {
    ts,
    getDescriptor,
    unwrap,
    getSourceText,
    analyzeStatementList,
    analyzeTernaries,
    analyzeMcdcDecision,
    getMcdcDecisionId,
    addScenarios,
    registerPipelineSummary,
    getLoopElementValue,
    cloneJson,
    makeAssignment,
    combineSolutions,
    getPipelineContext,
    getCallbackPredicateExpression,
    getCallbackPredicateSourceExpression,
    getNodeText,
    solveCondition,
    callbackUsesIndexParameter,
    callbackUsesIdentifier,
    getReduceIterationSpecs,
    getPipelineRepresentativeLength,
    addLoopScenario,
    recordLoopEntered,
    maxAlternatives,
  } = ports;

  function analyzeCall(call, incoming, ctx) {
    const descriptor = getDescriptor(call, ctx);
    if (!descriptor) return;
    const key = `${call.getStart(ctx.sourceFile)}:${descriptor.method}`;
    if (ctx.arrayCallbackSeen.has(key)) return;
    ctx.arrayCallbackSeen.add(key);

    const { method, collectionPath, callback } = descriptor;
    recordLoopEntered(ctx);
    const condition = getSourceText(call, ctx.sourceFile);
    registerPipelineSummary(descriptor, ctx);
    const itemValue = getLoopElementValue(collectionPath, ctx, call, '0');
    const secondItemValue = getLoopElementValue(collectionPath, ctx, call, '1');
    const variants = getCallbackCardinalityVariants(method, {
      itemValue: cloneJson(itemValue),
      secondItemValue: cloneJson(secondItemValue),
      hasInitialValue: descriptor.hasInitialValue,
    });

    for (const variant of variants) {
      let variantSolutions = combineSolutions(incoming, [makeAssignment(collectionPath, variant.value)], ctx.maxAlternatives);
      let variantPipelineTrace = [];
      if (variant.value.length > 0 && !descriptor.isReduce) {
        // The pipeline may require source elements beyond the nominal variant
        // length (for example a two-element sort comparator). Materialize those
        // source items too, because downstream callbacks may still see them.
        const requiresPair = descriptor.pipeline.some(stage =>
          ARRAY_COMPARATOR_METHODS.has(stage.method) || ['reverse', 'toReversed'].includes(stage.method));
        const maxSourceIndex = Math.max(variant.value.length - 1, requiresPair ? 1 : 0);
        const pipeline = getPipelineContext(descriptor, maxSourceIndex, ctx, maxSourceIndex);
        variantPipelineTrace = pipeline.trace;
        variantSolutions = combineSolutions(variantSolutions, pipeline.filterSolutions, ctx.maxAlternatives);

        const predicate = getCallbackPredicateExpression(callback);
        if (predicate && ARRAY_PREDICATE_METHODS.has(method)) {
          const indexIsUsed = callbackUsesIndexParameter(descriptor);
          for (let itemIndex = 0; itemIndex <= maxSourceIndex; itemIndex += 1) {
            const itemPipeline = getPipelineContext(descriptor, itemIndex, ctx, itemIndex);
            const callbackCtx = { ...ctx, pathAliases: itemPipeline.aliases };
            // Prefer a false witness at index 0 for index-sensitive predicates,
            // then a true witness at a later representative index.
            const preferredOutcome = indexIsUsed && itemIndex === 0 ? false : true;
            let predicateSolutions = solveCondition(predicate, preferredOutcome, callbackCtx);
            if (!predicateSolutions.length) predicateSolutions = solveCondition(predicate, !preferredOutcome, callbackCtx);
            if (predicateSolutions.length) variantSolutions = combineSolutions(variantSolutions, predicateSolutions, ctx.maxAlternatives);
          }
        }
      }
      addLoopScenario(ctx, call, `array-${method}`, condition, variant.outcome,
        variantSolutions,
        {
          phase: variant.phase,
          collection: collectionPath.join('.'),
          callbackMethod: method,
          ...(variantPipelineTrace.length ? { arrayPipelineTrace: variantPipelineTrace } : {}),
        });
    }

    const callbackUsesIndex = callback.parameters?.[1] && ts.isIdentifier(callback.parameters[1].name) && callbackUsesIdentifier(callback, callback.parameters[1].name.text);
    const isLastSearchingMethod = ['findLast', 'findLastIndex'].includes(method);
    const hasReorderingPipeline = descriptor.pipeline.some(stage => ARRAY_COMPARATOR_METHODS.has(stage.method) || ['reverse', 'toReversed'].includes(stage.method));
    const indices = getCallbackIterationIndices(method, {
      hasInitialValue: descriptor.hasInitialValue,
      callbackUsesIndex,
      hasReorderingPipeline,
    });

    for (const iterationIndex of indices) {
      const iterationSpecs = descriptor.isReduce
        ? getReduceIterationSpecs(descriptor, iterationIndex, itemValue, ctx)
        : ARRAY_COMPARATOR_METHODS.has(method)
          ? [{ arrayValue: [cloneJson(itemValue), cloneJson(secondItemValue)], accumulatorAlias: null, stateKey: null }]
          : [{
              arrayValue: Array.from({ length: getPipelineRepresentativeLength(descriptor, iterationIndex + 1) }, () => cloneJson(itemValue)),
              accumulatorAlias: null,
              stateKey: null,
            }];

      for (const iterationSpec of iterationSpecs) {
        const bodyIncoming = combineSolutions(incoming, [makeAssignment(collectionPath, iterationSpec.arrayValue)], ctx.maxAlternatives);
        const previousAliases = new Map(ctx.pathAliases);
        let arrayPipelineTrace = [];
        if (descriptor.isReduce) {
          const [accumulatorParameter, itemParameter, indexParameter] = callback.parameters;
          if (accumulatorParameter && ts.isIdentifier(accumulatorParameter.name) && iterationSpec.accumulatorAlias) {
            ctx.pathAliases.set(accumulatorParameter.name.text, iterationSpec.accumulatorAlias);
          }
          if (itemParameter && ts.isIdentifier(itemParameter.name)) {
            ctx.pathAliases.set(itemParameter.name.text, { kind: 'path', path: [...collectionPath, String(iterationIndex)] });
          }
          if (indexParameter && ts.isIdentifier(indexParameter.name)) {
            ctx.pathAliases.set(indexParameter.name.text, { kind: 'constant', value: iterationIndex });
          }
        } else if (ARRAY_COMPARATOR_METHODS.has(method)) {
          const [leftParameter, rightParameter, arrayParameter] = callback.parameters;
          if (leftParameter && ts.isIdentifier(leftParameter.name)) ctx.pathAliases.set(leftParameter.name.text, { kind: 'path', path: [...collectionPath, '0'] });
          if (rightParameter && ts.isIdentifier(rightParameter.name)) ctx.pathAliases.set(rightParameter.name.text, { kind: 'path', path: [...collectionPath, '1'] });
          if (arrayParameter && ts.isIdentifier(arrayParameter.name)) ctx.pathAliases.set(arrayParameter.name.text, { kind: 'path', path: collectionPath });
        } else {
          const pipelineContext = getPipelineContext(descriptor, iterationIndex, ctx, iterationIndex);
          arrayPipelineTrace = pipelineContext.trace;
          const combinedIncoming = combineSolutions(bodyIncoming, pipelineContext.filterSolutions, ctx.maxAlternatives);
          ctx.pathAliases.clear();
          for (const [name, alias] of pipelineContext.aliases) ctx.pathAliases.set(name, alias);
          bodyIncoming.splice(0, bodyIncoming.length, ...combinedIncoming);
        }

        const previousMetadata = ctx.activeAnalysisMetadata;
        ctx.activeAnalysisMetadata = {
          ...previousMetadata,
          callbackMethod: method,
          collection: collectionPath.join('.'),
          iterationIndex,
          callbackParameters: callback.parameters.map(parameter => ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(ctx.sourceFile)),
          callbackDescriptor: descriptor,
          callbackNode: callback,
          callbackBaseIncoming: incoming,
          callbackUsesIndex: callbackUsesIndexParameter(descriptor),
          ...(getCallbackPredicateSourceExpression(callback) ? { callbackSourceExpression: getNodeText(getCallbackPredicateSourceExpression(callback), ctx.sourceFile) } : {}),
          ...(arrayPipelineTrace.length ? { arrayPipelineTrace } : {}),
          ...(iterationSpec.stateKey ? { reduceStateKey: iterationSpec.stateKey } : {}),
        };
        try {
          if (!descriptor.isReduce && ARRAY_PREDICATE_METHODS.has(method)) {
            const predicateSource = getCallbackPredicateSourceExpression(callback);
            const predicate = getCallbackPredicateExpression(callback);
            if (predicate) {
              const predicateText = getNodeText(predicate, ctx.sourceFile);
              analyzeInNode(predicate, bodyIncoming, ctx);
              const runtimePredicate = predicateSource ?? predicate;
              analyzeMcdcDecision(predicate, bodyIncoming, ctx, `array-predicate-${method}`, runtimePredicate, runtimePredicate);
              const runtimeDecisionId = getMcdcDecisionId(`array-predicate-${method}`, runtimePredicate, ctx.sourceFile);
              addScenarios(ctx, 'array-predicate', predicate, predicateText, true, bodyIncoming, null, predicate,
                { callbackMethod: method, iterationIndex, runtimeDecisionId });
              addScenarios(ctx, 'array-predicate', predicate, predicateText, false, bodyIncoming, null, predicate,
                { callbackMethod: method, iterationIndex, runtimeDecisionId });
            } else if (ts.isBlock(callback.body)) {
              analyzeStatementList(callback.body.statements, bodyIncoming, ctx);
            }
          } else if (ts.isBlock(callback.body)) {
            analyzeStatementList(callback.body.statements, bodyIncoming, ctx);
          } else {
            analyzeTernaries(callback.body, bodyIncoming, ctx);
          }
        } finally {
          ctx.activeAnalysisMetadata = previousMetadata;
          ctx.pathAliases.clear();
          for (const [name, previous] of previousAliases) ctx.pathAliases.set(name, previous);
        }
      }
    }
  }

  const traversal = createCallbackTraversal({ ts, getDescriptor, unwrap, dispatchCall: analyzeCall });
  const analyzeInNode = traversal.analyzeInNode;

  return Object.freeze({ analyzeCall, analyzeInNode });
}
