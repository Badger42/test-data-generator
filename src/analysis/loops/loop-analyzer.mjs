import { planPathSensitiveLoop } from './path-sensitive-loop-planner.mjs';

/**
 * TypeScript-aware loop analysis adapter with injected solver and state ports.
 *
 * This module owns loop traversal semantics but deliberately receives all
 * compiler/solver/scenario operations through ports. It does not import
 * TypeScript runtime composition or the scenario materializer.
 */
export function createLoopAnalyzer(ports) {
  const {
    ts,
    getLoopCollectionPath,
    getLoopElementValue,
    getLoopBodyStatements,
    getLoopVariableName,
    getLoopInitialValue,
    substituteIdentifiers,
    loopProgressesTowardExit,
    localCounterProgressesTowardExit,
    applyNumericUpdates,
    applyLoopIncrementor,
    loopIterationLimit,
    addLoopScenario,
    recordLoopEntered,
    recordUnsupportedBranch,
    combineSolutions,
    makeAssignment,
    pathWithCondition,
    addScenarios,
    analyzeMcdcDecision,
    coverageAnchorMetadata,
    getMcdcDecisionId,
    walkStatements,
    maxAlternatives,
  } = ports;

  function analyzeForEachLoop(statement, incoming, ctx, isForIn) {
    const loopType = isForIn ? 'for-in' : 'for-of';
    const collectionPath = getLoopCollectionPath(statement.expression, ctx);
    const loopVariable = ts.isVariableDeclarationList(statement.initializer)
      ? getLoopVariableName(statement.initializer)
      : ts.isIdentifier(statement.initializer) ? statement.initializer.text : null;
    const condition = `${ts.isForInStatement(statement) ? 'key in ' : 'item of '}${statement.expression.getText(ctx.sourceFile)}`;
    recordLoopEntered(ctx);

    if (!collectionPath) {
      const branchId = ports.getBranchId('loop', statement, ctx.sourceFile);
      recordUnsupportedBranch(ctx, { branchId, outcome: 'iteration', reason: `Cannot resolve ${loopType} iterable to a function input property.` });
      const bodyFlow = walkStatements(getLoopBodyStatements(statement.statement), incoming, ctx);
      return { normal: incoming, breaks: [], continues: [], returns: bodyFlow.returns };
    }

    const propertyName = '__branch_scenario_key__';
    const itemValue = getLoopElementValue(collectionPath, ctx, statement, isForIn ? propertyName : '0');
    const oneValue = isForIn ? { [propertyName]: itemValue } : [itemValue];
    const multipleValue = isForIn
      ? { [propertyName]: itemValue, [`${propertyName}_2`]: ports.cloneJson(itemValue) }
      : [itemValue, ports.cloneJson(itemValue)];
    const variants = [
      { outcome: 'zero-iterations', value: isForIn ? {} : [], phase: 'before-first-iteration' },
      { outcome: 'one-iteration', value: oneValue, phase: 'first-iteration' },
      { outcome: 'multiple-iterations', value: multipleValue, phase: 'repeated-iteration' },
    ];
    for (const variant of variants) {
      addLoopScenario(ctx, statement, loopType, condition, variant.outcome,
        combineSolutions(incoming, [makeAssignment(collectionPath, variant.value)], ctx.maxAlternatives),
        { phase: variant.phase, collection: collectionPath.join('.') });
    }

    let bodyFlow;
    if (loopVariable) {
      const previous = ctx.pathAliases.get(loopVariable);
      ctx.pathAliases.set(loopVariable, isForIn
        ? { kind: 'key', value: propertyName }
        : { kind: 'path', path: [...collectionPath, '0'] });
      const bodyIncoming = combineSolutions(incoming, [makeAssignment(collectionPath, oneValue)], ctx.maxAlternatives);
      bodyFlow = walkStatements(getLoopBodyStatements(statement.statement), bodyIncoming, ctx);
      if (previous) ctx.pathAliases.set(loopVariable, previous);
      else ctx.pathAliases.delete(loopVariable);
    } else {
      bodyFlow = walkStatements(getLoopBodyStatements(statement.statement), incoming, ctx);
    }

    // The collection may finish naturally; break also exits this loop. Continue
    // is consumed by this loop and must not leak to an enclosing loop.
    return {
      normal: [...incoming, ...bodyFlow.breaks].slice(0, maxAlternatives(ctx)),
      breaks: [], continues: [], returns: bodyFlow.returns,
    };
  }

  function planNumericLoop(condition, incoming, ctx, initialState, transfer, options = {}) {
    if (!condition) return null;
    return planPathSensitiveLoop({
      initialState,
      maxIterations: loopIterationLimit?.(ctx) ?? 8,
      evaluate: state => {
        const conditionExpression = substituteIdentifiers(condition, state);
        return {
          continueSolutions: pathWithCondition(incoming, conditionExpression, true, ctx),
          exitSolutions: pathWithCondition(incoming, conditionExpression, false, ctx),
        };
      },
      transfer: (state, iteration) => transfer(state, iteration),
    });
  }

  function summarizeLoopPlan(plan) {
    return {
      schemaVersion: plan.schemaVersion,
      algorithm: plan.algorithm,
      iterationCount: plan.iterationCount,
      terminated: plan.terminated,
      fixedPoint: plan.fixedPoint,
      truncated: plan.truncated,
      exitSolutionCount: plan.exitSolutions.length,
      iterations: plan.iterations.map(item => ({
        iteration: item.iteration,
        state: { ...item.state },
        continueSolutionCount: item.continueSolutions.length,
        exitSolutionCount: item.exitSolutions.length,
      })),
      diagnostics: [...plan.diagnostics],
      limits: { ...plan.limits },
    };
  }

  function analyzeClassicForLoop(statement, incoming, ctx) {
    recordLoopEntered(ctx);
    const condition = statement.condition;
    const loopVariable = getLoopVariableName(statement.initializer);
    const initialValue = getLoopInitialValue(statement.initializer, loopVariable);
    const hasSubstitutableInitializer = Boolean(condition && loopVariable && initialValue.ok &&
      (typeof initialValue.value === 'number' || typeof initialValue.value === 'string' || typeof initialValue.value === 'boolean'));
    const replacements = new Map(ctx.localConstants);
    if (hasSubstitutableInitializer) replacements.set(loopVariable, initialValue.value);
    const solverCondition = condition ? substituteIdentifiers(condition, replacements) : condition;
    const conditionText = condition ? condition.getText(ctx.sourceFile) : 'true (no condition)';
    const coverageAnchor = coverageAnchorMetadata(ctx.sourceFile, statement, 'for-statement');
    const runtimeDecisionId = condition ? getMcdcDecisionId('for-loop', condition, ctx.sourceFile) : null;
    if (condition) analyzeMcdcDecision(condition, incoming, ctx, 'for-loop', condition);

    const previousAlias = loopVariable ? ctx.pathAliases.get(loopVariable) : undefined;
    if (loopVariable) {
      const index = initialValue.ok && Number.isInteger(initialValue.value) && initialValue.value >= 0 && initialValue.value <= 7
        ? initialValue.value : 0;
      ctx.pathAliases.set(loopVariable, { kind: 'index', index });
    }

    let bodyIncoming = incoming;
    let loopExitSolutions = [];
    if (condition) {
      const trueSolutions = pathWithCondition(incoming, solverCondition, true, ctx);
      const falseSolutions = pathWithCondition(incoming, solverCondition, false, ctx);
      addScenarios(ctx, 'loop', condition, conditionText, true, incoming, null, solverCondition,
        { loopType: 'for', phase: 'initial-condition', runtimeDecisionId, ...coverageAnchor });

      const loopPlan = hasSubstitutableInitializer ? planNumericLoop(condition, incoming, ctx, replacements, state => {
        let next = applyNumericUpdates(statement.statement, state);
        if (statement.incrementor && applyLoopIncrementor) next = applyLoopIncrementor(statement.incrementor, next);
        return next;
      }) : null;
      const plannedExit = loopPlan?.exitSolutions ?? [];
      if (falseSolutions.length) {
        loopExitSolutions = falseSolutions;
        addScenarios(ctx, 'loop', condition, conditionText, false, incoming, null, solverCondition,
          { loopType: 'for', phase: 'zero-iterations', runtimeDecisionId, ...coverageAnchor });
      } else if (plannedExit.length && trueSolutions.length) {
        loopExitSolutions = plannedExit;
        addLoopScenario(ctx, condition, 'for', conditionText, false, plannedExit,
          { phase: 'exit-after-iterations', loopVariable, initialValue: initialValue.value,
            iterations: loopPlan.iterationCount, boundedUnrolling: true, runtimeDecisionId, ...coverageAnchor });
      } else if (hasSubstitutableInitializer && loopProgressesTowardExit(statement, loopVariable) && trueSolutions.length) {
        // Compatibility fallback for initializer/incrementor forms not modeled by the bounded transfer.
        loopExitSolutions = trueSolutions;
        addLoopScenario(ctx, condition, 'for', conditionText, false, trueSolutions,
          { phase: 'exit-after-iterations', loopVariable, initialValue: initialValue.value, runtimeDecisionId, ...coverageAnchor });
      } else {
        loopExitSolutions = [];
        addScenarios(ctx, 'loop', condition, conditionText, false, incoming, null, solverCondition,
          { loopType: 'for', phase: 'condition-false', runtimeDecisionId, ...coverageAnchor });
      }
      bodyIncoming = trueSolutions;
      if (loopPlan && ctx.dataFlowLoopPlans) ctx.dataFlowLoopPlans.push(summarizeLoopPlan(loopPlan));
    } else {
      addLoopScenario(ctx, statement, 'for', conditionText, 'one-or-more-iterations', incoming,
        { phase: 'unconditional-loop' });
    }

    const bodyFlow = walkStatements(getLoopBodyStatements(statement.statement), bodyIncoming, ctx);
    if (loopVariable) {
      if (previousAlias) ctx.pathAliases.set(loopVariable, previousAlias);
      else ctx.pathAliases.delete(loopVariable);
    }
    return {
      normal: [...loopExitSolutions, ...bodyFlow.breaks].slice(0, maxAlternatives(ctx)),
      breaks: [], continues: [], returns: bodyFlow.returns,
    };
  }

  function analyzeWhileLoop(statement, incoming, ctx, isDoWhile) {
    recordLoopEntered(ctx);
    const condition = statement.expression;
    const conditionText = condition.getText(ctx.sourceFile);
    analyzeMcdcDecision(condition, incoming, ctx, isDoWhile ? 'do-while-loop' : 'while-loop', condition);
    const replacements = new Map(ctx.localConstants);
    if (isDoWhile) {
      // The condition is evaluated after the first body execution. Account for a
      // simple local numeric increment such as `do { count++; } while (count < limit)`.
      for (const [name, value] of applyNumericUpdates(statement.statement, ctx.localConstants)) replacements.set(name, value);
    }
    const solverCondition = substituteIdentifiers(condition, replacements);
    const coverageAnchor = coverageAnchorMetadata(ctx.sourceFile, statement, isDoWhile ? 'do-while-statement' : 'while-statement');
    const runtimeDecisionId = getMcdcDecisionId(isDoWhile ? 'do-while-loop' : 'while-loop', condition, ctx.sourceFile);
    const metadata = { loopType: isDoWhile ? 'do-while' : 'while', phase: isDoWhile ? 'after-first-iteration' : 'condition-check', runtimeDecisionId, ...coverageAnchor };
    const trueSolutions = pathWithCondition(incoming, solverCondition, true, ctx);
    const falseSolutions = pathWithCondition(incoming, solverCondition, false, ctx);
    let loopExitSolutions = falseSolutions;
    addScenarios(ctx, 'loop', condition, conditionText, true, incoming, null, solverCondition, metadata);
    const initialLoopState = isDoWhile ? applyNumericUpdates(statement.statement, ctx.localConstants) : replacements;
    const loopPlan = planNumericLoop(condition, incoming, ctx, initialLoopState,
      state => applyNumericUpdates(statement.statement, state));
    const plannedExit = loopPlan?.exitSolutions ?? [];
    if (falseSolutions.length) {
      addScenarios(ctx, 'loop', condition, conditionText, false, incoming, null, solverCondition, metadata);
    } else if (plannedExit.length && trueSolutions.length) {
      loopExitSolutions = plannedExit;
      addLoopScenario(ctx, condition, isDoWhile ? 'do-while' : 'while', conditionText, false, plannedExit,
        { phase: 'exit-after-iterations', iterations: loopPlan.iterationCount + (isDoWhile ? 1 : 0), boundedUnrolling: true, runtimeDecisionId, ...coverageAnchor });
    } else if (localCounterProgressesTowardExit(condition, statement.statement, replacements) && trueSolutions.length) {
      loopExitSolutions = trueSolutions;
      addLoopScenario(ctx, condition, isDoWhile ? 'do-while' : 'while', conditionText, false, trueSolutions,
        { phase: 'exit-after-iterations', runtimeDecisionId, ...coverageAnchor });
    } else {
      loopExitSolutions = [];
      addScenarios(ctx, 'loop', condition, conditionText, false, incoming, null, solverCondition, metadata);
    }
    if (loopPlan && ctx.dataFlowLoopPlans) ctx.dataFlowLoopPlans.push(summarizeLoopPlan(loopPlan));

    // A do...while body always executes once before its condition is evaluated.
    const bodyIncoming = isDoWhile ? incoming : trueSolutions;
    const bodyFlow = walkStatements(getLoopBodyStatements(statement.statement), bodyIncoming, ctx);
    return {
      normal: [...loopExitSolutions, ...bodyFlow.breaks].slice(0, maxAlternatives(ctx)),
      breaks: [], continues: [], returns: bodyFlow.returns,
    };
  }

  return { analyzeForEachLoop, analyzeClassicForLoop, analyzeWhileLoop };
}
