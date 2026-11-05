function parseSimplePath(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\]))*$/);
  if (!match) return null;
  const segments = [];
  const root = value.trim().match(/^([A-Za-z_$][\w$]*)/);
  if (!root) return null;
  segments.push(root[1]);
  const tail = value.trim().slice(root[0].length);
  const parts = [...tail.matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\]/g)];
  if (parts.map(part => part[0]).join('').replace(/\s/g, '') !== tail.replace(/\s/g, '')) return null;
  for (const part of parts) segments.push(part[1] ?? part[2]);
  return segments;
}

function substituteEffectPath(effect, callee, call) {
  const path = Array.isArray(effect.path) ? effect.path : [];
  const parameterIndex = callee.parameters.findIndex(parameter => parameter.name === path[0]);
  if (parameterIndex < 0) return { ...effect, path: [...path], propagation: 'captured-or-global' };
  const argument = call.arguments?.[parameterIndex]?.expressionText;
  const argumentPath = parseSimplePath(argument);
  if (!argumentPath) {
    return { ...effect, path: [...path], certainty: 'possible', propagation: 'unresolved-argument' };
  }
  return {
    ...effect,
    path: [...argumentPath, ...path.slice(1)],
    expression: [...argumentPath, ...path.slice(1)].join('.'),
    propagation: 'parameter-substitution',
  };
}


function instantiateReturnValue(returnFact, callee, call) {
  const value = returnFact?.value;
  if (!value) return { kind: 'unknown', expressionText: returnFact?.expressionText ?? null, confidence: 'low' };
  if (value.kind === 'constant') return { kind: 'constant', value: value.value, confidence: 'high' };
  if (value.kind === 'path') {
    const parameterIndex = callee.parameters.findIndex(parameter => parameter.name === value.rootName);
    if (parameterIndex >= 0) {
      const argumentText = call.arguments?.[parameterIndex]?.expressionText;
      const argumentPath = parseSimplePath(argumentText);
      if (!argumentPath) return { kind: 'unknown', expressionText: returnFact.expressionText, confidence: 'low', reason: 'non-path-argument' };
      const path = [...argumentPath, ...(value.segments ?? [])];
      return { kind: 'path', path, expression: path.join('.'), parameterIndex, confidence: 'high', substitution: 'argument-path' };
    }
    return { kind: 'captured-path', path: [value.rootName, ...(value.segments ?? [])], expression: [value.rootName, ...(value.segments ?? [])].join('.'), confidence: 'medium' };
  }
  return { kind: 'unknown', expressionText: returnFact.expressionText, confidence: 'low', reason: 'computed-return-expression' };
}

function buildCallBindings(callee, call) {
  return callee.parameters.map(parameter => {
    const argument = call.arguments?.[parameter.index];
    const path = parseSimplePath(argument?.expressionText);
    return {
      parameterIndex: parameter.index,
      parameterName: parameter.name,
      argumentText: argument?.expressionText ?? null,
      argumentPath: path,
      resolved: Boolean(path),
    };
  });
}

function stronglyConnectedComponents(nodes, edges) {
  const adjacency = new Map(nodes.map(node => [node.functionId, []]));
  for (const edge of edges) if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const components = [];
  const visit = node => {
    index.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) === index.get(node)) {
      const members = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        members.push(current);
      } while (current !== node);
      components.push(members.sort());
    }
  };
  for (const node of nodes) if (!index.has(node.functionId)) visit(node.functionId);
  return components;
}

/**
 * Builds a bounded local call graph and propagates only explicit effects.
 * It never inlines expressions or upgrades an unknown effect to a definite one.
 */
export function buildInterproceduralSummary(functionSummaries = [], callSites = [], rootMutations = []) {
  const byId = new Map(functionSummaries.map(summary => [summary.functionId, summary]));
  const edges = [];
  for (const summary of functionSummaries) {
    for (const call of summary.calls ?? []) {
      if (!call.resolvedSummaryId || !byId.has(call.resolvedSummaryId)) continue;
      edges.push({
        from: summary.functionId,
        to: call.resolvedSummaryId,
        callee: call.callee,
        arguments: call.arguments ?? [],
        callId: call.callId ?? null,
        sourceSpan: call.sourceSpan,
      });
    }
  }
  const components = stronglyConnectedComponents(functionSummaries, edges);
  const recursiveIds = new Set();
  const recursiveComponents = [];
  for (const component of components) {
    const cyclic = component.length > 1 || edges.some(edge => edge.from === component[0] && edge.to === component[0]);
    if (cyclic) {
      for (const id of component) recursiveIds.add(id);
      recursiveComponents.push(component);
    }
  }

  // Recursive SCCs are widened before caller propagation. Marking them only
  // in the final projection allowed their callers to observe stale `pure`
  // values during the fixed-point pass and incorrectly enable return aliases.
  const state = new Map(functionSummaries.map(summary => [summary.functionId, {
    purity: recursiveIds.has(summary.functionId) && summary.purity !== 'impure' ? 'unknown' : summary.purity,
    effects: (summary.effects ?? []).map(effect => ({ ...effect, path: [...(effect.path ?? [])], propagation: 'direct' })),
  }]));
  const stableKey = value => JSON.stringify({ purity: value.purity, effects: value.effects.map(effect => ({ path: effect.path, kind: effect.kind, certainty: effect.certainty, propagation: effect.propagation })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  const maxPasses = Math.max(1, functionSummaries.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (const summary of functionSummaries) {
      if (recursiveIds.has(summary.functionId)) continue;
      const current = state.get(summary.functionId);
      const next = { purity: current.purity, effects: [...current.effects] };
      for (const edge of edges.filter(item => item.from === summary.functionId)) {
        const callee = byId.get(edge.to);
        const calleeState = state.get(edge.to);
        if (!callee || !calleeState) continue;
        if (calleeState.purity === 'impure') next.purity = 'impure';
        else if (calleeState.purity === 'unknown' && next.purity !== 'impure') next.purity = 'unknown';
        next.effects.push(...calleeState.effects.map(effect => substituteEffectPath(effect, callee, edge)));
      }
      const deduped = new Map();
      for (const effect of next.effects) {
        const key = `${effect.kind}:${(effect.path ?? []).join('.')}:${effect.certainty}:${effect.propagation}`;
        if (!deduped.has(key)) deduped.set(key, effect);
      }
      next.effects = [...deduped.values()];
      if (stableKey(next) !== stableKey(current)) {
        state.set(summary.functionId, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const summaries = functionSummaries.map(summary => {
    const derived = state.get(summary.functionId);
    const recursive = recursiveIds.has(summary.functionId);
    return {
      ...summary,
      directPurity: summary.purity,
      purity: recursive && derived.purity !== 'impure' ? 'unknown' : derived.purity,
      recursive,
      transitiveEffects: derived.effects,
      inlineable: false,
    };
  });
  const enrichedById = new Map(summaries.map(summary => [summary.functionId, summary]));
  const rootEffects = rootMutations
    .filter(effect => effect.kind !== 'returned-reference')
    .map(effect => ({
      kind: effect.kind,
      path: [...(effect.path ?? [])],
      certainty: effect.certainty,
      expression: effect.expression,
      callId: null,
      targetFunctionId: null,
      propagation: 'direct-root',
    }));
  const instantiatedCalls = [];
  const returnValueFacts = [];
  for (const call of callSites) {
    const target = call.targetFunctionId ? enrichedById.get(call.targetFunctionId) : null;
    if (!target) continue;
    const effects = target.transitiveEffects.map(effect => substituteEffectPath(effect, target, call));
    for (const effect of effects) rootEffects.push({ ...effect, callId: call.callId, targetFunctionId: target.functionId });
    const returnValues = (target.returns ?? []).map(returnFact => instantiateReturnValue(returnFact, target, call));
    const completeReturnModel = returnValues.length > 0 && returnValues.every(value => value.kind !== 'unknown');
    const bindings = buildCallBindings(target, call);
    instantiatedCalls.push({
      callId: call.callId,
      functionId: target.functionId,
      callee: target.name,
      argumentBindings: bindings,
      purity: target.purity,
      effects,
      returnValues,
      returnModelComplete: completeReturnModel,
    });
    returnValueFacts.push({
      callId: call.callId,
      targetFunctionId: target.functionId,
      callee: target.name,
      values: returnValues,
      complete: completeReturnModel,
      confidence: completeReturnModel && returnValues.every(value => value.confidence === 'high') ? 'high' : 'low',
      usableAsConstraintAlias: target.purity === 'pure' && completeReturnModel && returnValues.length === 1 && returnValues[0].kind === 'path',
    });
  }
  const directRootPurity = rootMutations.some(effect => effect.kind !== 'returned-reference' && effect.certainty === 'definite')
    ? 'impure'
    : rootMutations.some(effect => effect.kind !== 'returned-reference') ? 'unknown' : 'pure';
  const rootPurity = callSites.reduce((purity, call) => {
    const target = call.targetFunctionId ? enrichedById.get(call.targetFunctionId) : null;
    if (!target) return call.knownPure ? purity : purity === 'impure' ? purity : 'unknown';
    if (target.purity === 'impure') return 'impure';
    if (target.purity === 'unknown' && purity !== 'impure') return 'unknown';
    return purity;
  }, directRootPurity);

  return Object.freeze({
    schemaVersion: '1.0',
    nodes: Object.freeze(summaries.map(summary => Object.freeze({ functionId: summary.functionId, name: summary.name, purity: summary.purity, recursive: summary.recursive }))),
    edges: Object.freeze(edges.map(edge => Object.freeze(edge))),
    components: Object.freeze(components.map(component => Object.freeze(component))),
    recursiveComponents: Object.freeze(recursiveComponents.map(component => Object.freeze(component))),
    rootCallSites: Object.freeze(callSites.filter(call => call.targetFunctionId).map(call => Object.freeze({ callId: call.callId, targetFunctionId: call.targetFunctionId, callee: call.callee }))),
    instantiatedCalls: Object.freeze(instantiatedCalls.map(item => Object.freeze(item))),
    returnValueFacts: Object.freeze(returnValueFacts.map(item => Object.freeze(item))),
    rootPurity,
    rootEffects: Object.freeze(rootEffects),
    summaries: Object.freeze(summaries.map(summary => Object.freeze(summary))),
    diagnostics: Object.freeze(recursiveComponents.map(component => ({
      code: 'RECURSIVE_LOCAL_CALL_GRAPH', severity: 'warning', functionIds: component,
      message: 'Recursive local summaries are retained as descriptive facts; transitive expansion is not used to prove purity or solve constraints.',
    }))),
    limits: Object.freeze({ expressionInlining: false, recursiveExpansion: false, effectCertaintyUpgrade: false }),
  });
}
