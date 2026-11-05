/**
 * Coordinates unique-cause MC/DC pair planning, joint atom solving, callback contexts,
 * and scenario-side materialization. AST and solver details are injected ports.
 */
export function createMcdcAnalysisOrchestrator(dependencies) {
  const {
    ts, compileTypescriptCondition,
    substituteKnownAliases, constraintPathHint,
    buildConstraintSeed, hasIncomingPathOverlap, hasAnyIncomingPathOverlap,
    preservesMcdcIncomingAssignments, readConstraintPath, isDefinitelyAssignable, makeAssignment,
    combineSolutions, solveCondition, deriveAnalysisOperationContext, createConstraintIR, logical, negate,
    getBranchId, formatLine, getNodeText, planUniqueCauseCandidates,
    verifyUniqueCauseCandidate, evaluateMcdcExpression, collectMcdcAtomicConditions, mcdcNodeKey,
    buildMcdcScenario, callbackUsesIndexParameter, getLoopElementValue, cloneJson,
    getPipelineRepresentativeLength, getArrayPipelineContext,
  } = dependencies;

function createMcdcAstContext(operationContext) {
  return {
    fn: operationContext.function.node,
    sourceFile: operationContext.function.sourceFile,
    checker: operationContext.function.checker,
    parameterMap: operationContext.paths.parameterMap,
    localMockMap: operationContext.paths.localMockMap,
    baseArgs: operationContext.paths.baseArgs,
    inferredPaths: operationContext.paths.inferredPaths,
    dataFlowModel: operationContext.paths.dataFlowModel,
    pathAliases: operationContext.paths.pathAliases,
    maxAlternatives: operationContext.limits.maxAlternatives,
    activeAnalysisMetadata: operationContext.arrays.metadata,
    generateMcdc: operationContext.mcdc.enabled,
    mcdcDecisionSeen: operationContext.mcdc.seen,
  };
}

function renameConstraintAtomIds(expression, prefix) {
  let index = 0;
  const visit = node => {
    if (node.kind === 'atom') return { ...node, id: `${prefix}_${++index}` };
    if (node.kind === 'not') return { ...node, operand: visit(node.operand) };
    if (node.kind === 'logical') return { ...node, operands: node.operands.map(visit) };
    return { ...node };
  };
  return visit(expression);
}

function containsUnresolvedAliasReference(node, aliases) {
  let found = false;
  const visit = current => {
    if (!current || found) return;
    if (ts.isIdentifier(current) && aliases.has(current.text) &&
        !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function trySolveMcdcWithConstraintIR(atoms, values, incoming, operationContext) {
  const pathAliases = operationContext.paths.pathAliases;
  if (operationContext.constraints.engine !== 'hybrid') return null;
  operationContext.events.incrementConstraintStat('irAttempts');
  let expressions = [];
  const pathTypes = {};
  try {
    for (let index = 0; index < atoms.length; index += 1) {
      const original = atoms[index].node;
      const expression = substituteKnownAliases(original, pathAliases);
      if (containsUnresolvedAliasReference(expression, pathAliases)) {
        operationContext.events.recordConstraintFallback('MC/DC atom contains an unresolved callback/local alias');
        return null;
      }
      const provisional = compileTypescriptCondition(expression, ts);
      for (const item of provisional.atoms) {
        if (item.operator === 'unsupported') continue;
        const operandPaths = [item.path, ...(item.valuePath ? [item.valuePath] : [])];
        for (const path of operandPaths) {
          const { hint } = constraintPathHint(path, operationContext, original);
          pathTypes[JSON.stringify(path)] = hint;
        }
      }
      const compiled = compileTypescriptCondition(expression, ts, { pathTypes });
      let conditionExpr = renameConstraintAtomIds(compiled.expression, `M${index + 1}`);
      if (!values[index]) conditionExpr = negate(conditionExpr);
      expressions.push(conditionExpr);
    }
  } catch (error) {
    operationContext.events.recordConstraintFallback(`MC/DC IR compilation: ${error.message}`);
    return null;
  }

  if (!expressions.length) return [];
  const expression = expressions.length === 1 ? expressions[0] : logical('and', expressions);
  const ir = createConstraintIR(expression);
  if (ir.atoms.some(item => item.operator === 'unsupported')) {
    operationContext.events.recordConstraintFallback('MC/DC decision contains an unsupported IR atom');
    return null;
  }
  const hasPathToPathAtoms = ir.atoms.some(item => item.valuePath);
  if (incoming.some(solution => solution.unsupported?.length ||
      (hasPathToPathAtoms ? hasIncomingPathOverlap(solution, ir.atoms) : hasAnyIncomingPathOverlap(solution, ir.atoms)))) {
    operationContext.events.recordConstraintFallback('MC/DC incoming path constraints overlap atom assignments or are unsupported');
    return null;
  }

  const results = [];
  for (const incomingSolution of incoming) {
    const seed = buildConstraintSeed(incomingSolution, ir.atoms, operationContext, atoms[0].node);
    const incomingAssignments = [...incomingSolution.assignments.values()];
    const solved = operationContext.constraints.solver.solveAll(ir, {
      desired: true,
      maxCandidates: Math.min(8192, Math.max(512, operationContext.limits.maxScenarios * 96)),
      maxSolutions: 1,
      maxBranches: operationContext.limits.maxMcdcCombinations ?? 512,
      seed,
      pathTypes: Object.fromEntries(ir.atoms.flatMap(item => [
        [JSON.stringify(item.path), item.pathTypeHint ?? item.pathType ?? 'unknown'],
        ...(item.valuePath ? [[JSON.stringify(item.valuePath), item.valuePathTypeHint ?? 'unknown']] : []),
      ])),
    });
    if (solved.status === 'unsatisfiable' && solved.complete) continue;
    if (solved.status !== 'solved' || !solved.solutions.length) {
      operationContext.events.recordConstraintFallback(`MC/DC IR ${solved.status}: ${solved.reason ?? 'no feasible assignment'}`);
      return null;
    }
    if (solved.truncated) operationContext.events.incrementConstraintStat('irTruncated');
    const assignmentSet = solved.solutions.find(candidate => preservesMcdcIncomingAssignments(
      seed, candidate, incomingAssignments, ir.atoms, solved.solutionDomains?.[0] ?? [],
    ));
    if (!assignmentSet) continue;
    const paths = new Map(ir.atoms.flatMap(item => [
      [JSON.stringify(item.path), item.path],
      ...(item.valuePath ? [[JSON.stringify(item.valuePath), item.valuePath]] : []),
    ]));
    const assignments = new Map();
    for (const path of [...paths.values()].sort((a, b) => a.length - b.length || a.join('.').localeCompare(b.join('.')))) {
      const found = readConstraintPath(assignmentSet, path);
      const { type } = constraintPathHint(path, operationContext, atoms[0].node);
      if (type && !isDefinitelyAssignable(found.value, type)) {
        operationContext.events.recordConstraintFallback(`MC/DC Solver candidate is incompatible with TypeScript type at ${path.join('.')}`);
        return null;
      }
      const assignment = makeAssignment(path, found.value).assignments.values().next().value;
      assignments.set(path.join('.'), assignment);
    }
    results.push({ assignments, unsupported: [] });
  }

  if (!results.length) {
    operationContext.events.recordConstraintFallback('No MC/DC IR witness preserved the incoming path assignments.');
    return null;
  }

  operationContext.events.incrementConstraintStat('mcdcIrSolved', results.length);
  operationContext.events.incrementConstraintStat('irSolved', results.length);
  operationContext.events.incrementConstraintStat('irSolutionCount', results.length);
  return combineSolutions(incoming, results, operationContext.limits.maxAlternatives).filter(solution => solution.unsupported.length === 0);
}

function solveMcdcAssignment(atoms, values, incoming, operationContext) {
  const irSolutions = trySolveMcdcWithConstraintIR(atoms, values, incoming, operationContext);
  if (irSolutions !== null) return irSolutions;

  let solutions = [{ assignments: new Map(), unsupported: [] }];
  const fallbackContext = deriveAnalysisOperationContext(operationContext, {
    constraints: { engine: 'recursive-ast' },
  });
  for (let index = 0; index < atoms.length; index += 1) {
    const atomSolutions = solveCondition(atoms[index].node, values[index], fallbackContext)
      .filter(solution => solution.unsupported.length === 0);
    if (!atomSolutions.length) return [];
    solutions = combineSolutions(solutions, atomSolutions, operationContext.limits.maxAlternatives);
    if (!solutions.length) return [];
  }
  return combineSolutions(incoming, solutions, operationContext.limits.maxAlternatives)
    .filter(solution => solution.unsupported.length === 0);
}

function getMcdcCallbackContextVariants(incoming, operationContext) {
  const metadata = operationContext.arrays.metadata ?? {};
  const descriptor = metadata.callbackDescriptor;
  if (!descriptor || !callbackUsesIndexParameter(descriptor)) {
    return [{ incoming, operationContext, context: createMcdcAstContext(operationContext) }];
  }

  const baseIncoming = metadata.callbackBaseIncoming ?? incoming;
  const variants = [];
  for (const iterationIndex of [0, 1]) {
    const candidateOperationContext = deriveAnalysisOperationContext(operationContext, {
      paths: { pathAliases: new Map(operationContext.paths.pathAliases) },
      arrays: { metadata: { ...metadata, iterationIndex } },
    });
    const candidateContext = createMcdcAstContext(candidateOperationContext);
    const itemValue = getLoopElementValue(descriptor.collectionPath, candidateContext, descriptor.call, '0');
    const arrayValue = Array.from({ length: getPipelineRepresentativeLength(descriptor, iterationIndex + 1) }, () => cloneJson(itemValue));
    let candidateIncoming = combineSolutions(baseIncoming, [makeAssignment(descriptor.collectionPath, arrayValue)], candidateContext.maxAlternatives);
    const pipelineContext = getArrayPipelineContext(descriptor, iterationIndex, candidateContext, iterationIndex);
    candidateIncoming = combineSolutions(candidateIncoming, pipelineContext.filterSolutions, candidateContext.maxAlternatives);
    candidateContext.pathAliases.clear();
    for (const [name, alias] of pipelineContext.aliases) candidateContext.pathAliases.set(name, alias);

    const finalOperationContext = deriveAnalysisOperationContext(candidateOperationContext, {
      paths: { pathAliases: new Map(candidateContext.pathAliases) },
    });
    variants.push({
      incoming: candidateIncoming,
      operationContext: finalOperationContext,
      context: createMcdcAstContext(finalOperationContext),
    });
  }
  return variants;
}

function analyzeMcdcDecision(condition, incoming, operationContext, kind, decisionNode = condition, runtimeExpressionNode = condition) {
  const ctx = createMcdcAstContext(operationContext);
  if (!ctx.generateMcdc) return;
  const decisionId = getBranchId(`mcdc-${kind}`, decisionNode, ctx.sourceFile);
  if (ctx.mcdcDecisionSeen.has(decisionId)) return;
  ctx.mcdcDecisionSeen.add(decisionId);

  const nodes = collectMcdcAtomicConditions(condition, ctx.sourceFile);
  const uniqueNodes = [];
  const seen = new Set();
  for (const node of nodes) {
    const key = mcdcNodeKey(node, ctx.sourceFile);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNodes.push({ key, node, expression: node.getText(ctx.sourceFile) });
  }

  const position = formatLine(ctx.sourceFile, decisionNode);
  const callbackContext = ctx.activeAnalysisMetadata?.callbackMethod ? {
    method: ctx.activeAnalysisMetadata.callbackMethod,
    ...(ctx.activeAnalysisMetadata.collection ? { collection: ctx.activeAnalysisMetadata.collection } : {}),
    ...(ctx.activeAnalysisMetadata.iterationIndex !== undefined ? { iterationIndex: ctx.activeAnalysisMetadata.iterationIndex } : {}),
    ...(ctx.activeAnalysisMetadata.callbackUsesIndex ? { candidateIterationIndexes: [0, 1] } : {}),
    ...(ctx.activeAnalysisMetadata.callbackParameters?.length ? { parameters: ctx.activeAnalysisMetadata.callbackParameters } : {}),
    ...(ctx.activeAnalysisMetadata.arrayPipelineTrace?.length ? { pipeline: ctx.activeAnalysisMetadata.arrayPipelineTrace } : {}),
  } : undefined;
  const decision = {
    decisionId,
    kind,
    line: position.line,
    column: position.column,
    expression: getNodeText(condition, ctx.sourceFile),
    runtimeExpressionRange: runtimeExpressionNode ? { startOffset: runtimeExpressionNode.getStart(ctx.sourceFile), endOffset: runtimeExpressionNode.end } : null,
    ...(ctx.activeAnalysisMetadata?.callbackSourceExpression ? { sourceExpression: ctx.activeAnalysisMetadata.callbackSourceExpression } : {}),
    criterion: 'unique-cause',
    ...(callbackContext ? { callbackContext } : {}),
    conditions: [],
  };
  operationContext.events.dispatch({ type: 'analysis.mcdc-conditions-counted', count: uniqueNodes.length });

  if (!uniqueNodes.length) {
    decision.analysisStatus = 'unsupported';
    decision.reason = 'No atomic conditions were extracted from this decision.';
    operationContext.events.dispatch({ type: 'analysis.mcdc-decision-added', decision });
    return;
  }
  const maxMcdcAtoms = operationContext.limits.maxMcdcAtoms ?? 10;
  if (uniqueNodes.length > maxMcdcAtoms) {
    decision.analysisStatus = 'unsupported';
    decision.reason = `Decision contains ${uniqueNodes.length} atomic conditions; the configured limit is ${maxMcdcAtoms}.`;
    for (let i = 0; i < uniqueNodes.length; i += 1) {
      const item = { id: `C${i + 1}`, expression: uniqueNodes[i].expression, independencePairs: [], status: 'unsupported', reason: decision.reason };
      decision.conditions.push(item);
      const missingPair = { decisionId, conditionId: item.id, expression: item.expression, reason: decision.reason };
      operationContext.events.dispatch({ type: 'analysis.mcdc-condition-without-pair', condition: missingPair });
    }
    operationContext.events.dispatch({ type: 'analysis.mcdc-decision-added', decision });
    return;
  }

  for (let targetIndex = 0; targetIndex < uniqueNodes.length; targetIndex += 1) {
    const target = uniqueNodes[targetIndex];
    const conditionId = `C${targetIndex + 1}`;
    const pairPlan = planUniqueCauseCandidates({
      atomCount: uniqueNodes.length,
      targetIndex,
      maxCombinations: operationContext.limits.maxMcdcCombinations ?? 512,
      evaluateDecision: values => evaluateMcdcExpression(
        condition,
        new Map(uniqueNodes.map((item, index) => [item.key, values[index]])),
        ctx.sourceFile,
      ),
    });
    let foundPair = null;
    let unsupportedReason = null;

    for (const candidate of pairPlan.candidates) {
      if (foundPair) break;
      const { baseValues, falseValues, trueValues, falseDecision, trueDecision } = candidate;
      if (!verifyUniqueCauseCandidate(candidate)) continue;
      const falseMap = new Map(uniqueNodes.map((item, index) => [item.key, falseValues[index]]));
      const trueMap = new Map(uniqueNodes.map((item, index) => [item.key, trueValues[index]]));

      const callbackContexts = getMcdcCallbackContextVariants(incoming, operationContext);
      let solvedPair = null;
      for (const falseContext of callbackContexts) {
        const falseSolutions = solveMcdcAssignment(uniqueNodes, falseValues, falseContext.incoming, falseContext.operationContext);
        if (!falseSolutions.length) continue;
        for (const trueContext of callbackContexts) {
          const trueSolutions = solveMcdcAssignment(uniqueNodes, trueValues, trueContext.incoming, trueContext.operationContext);
          if (!trueSolutions.length) continue;
          // Confirm that the materialized assignments are independently solvable
          // in their own callback invocation contexts (for example index 0 vs 1).
          solvedPair = { falseContext, trueContext, falseSolution: falseSolutions[0], trueSolution: trueSolutions[0] };
          break;
        }
        if (solvedPair) break;
      }
      if (!solvedPair) {
        unsupportedReason = 'The logical independence pair exists, but no consistent input assignments were found across the supported callback indexes.';
        continue;
      }

      const fixedConditions = candidate.fixedConditions;
      const pairOrdinal = 1;
      const pairId = `${decisionId}-${conditionId}-pair-${pairOrdinal}`;
      const conditionFalseScenario = buildMcdcScenario(
        solvedPair.falseSolution, solvedPair.falseContext.context, decisionNode, `${pairId}-condition-false`,
        Object.fromEntries(uniqueNodes.map((item, index) => [`C${index + 1}`, falseValues[index]])), falseDecision,
      );
      const conditionTrueScenario = buildMcdcScenario(
        solvedPair.trueSolution, solvedPair.trueContext.context, decisionNode, `${pairId}-condition-true`,
        Object.fromEntries(uniqueNodes.map((item, index) => [`C${index + 1}`, trueValues[index]])), trueDecision,
      );
      foundPair = {
        pairId,
        fixedConditions,
        changedCondition: conditionId,
        ...(solvedPair.falseContext.context.activeAnalysisMetadata?.iterationIndex !== solvedPair.trueContext.context.activeAnalysisMetadata?.iterationIndex ? {
          variedCallbackIndex: {
            conditionFalse: solvedPair.falseContext.context.activeAnalysisMetadata?.iterationIndex,
            conditionTrue: solvedPair.trueContext.context.activeAnalysisMetadata?.iterationIndex,
          },
        } : {}),
        decisionOutcomes: { conditionFalse: falseDecision, conditionTrue: trueDecision },
        scenarios: {
          conditionFalse: conditionFalseScenario,
          conditionTrue: conditionTrueScenario,
        },
      };
    }

    const conditionResult = {
      id: conditionId,
      expression: target.expression,
      runtimeExpressionRange: { startOffset: target.node.getStart(ctx.sourceFile), endOffset: target.node.end },
      independencePairs: foundPair ? [foundPair] : [],
      status: foundPair ? 'covered' : 'no-pair',
      ...(!foundPair ? { reason: unsupportedReason ?? 'No feasible unique-cause independence pair was found for this condition.' } : {}),
    };
    decision.conditions.push(conditionResult);
    if (foundPair) {
      operationContext.events.dispatch({ type: 'analysis.mcdc-pair-found' });
    } else {
      const missingPair = {
        decisionId,
        conditionId,
        expression: target.expression,
        reason: conditionResult.reason,
      };
      operationContext.events.dispatch({ type: 'analysis.mcdc-condition-without-pair', condition: missingPair });
    }
  }
  decision.analysisStatus = decision.conditions.every(item => item.status === 'covered') ? 'complete' : 'partial';
  operationContext.events.dispatch({ type: 'analysis.mcdc-decision-added', decision });
}


  return Object.freeze({
    analyzeMcdcDecision,
    solveMcdcAssignment,
    getMcdcCallbackContextVariants,
    callbackUsesIndexParameter,
  });
}
