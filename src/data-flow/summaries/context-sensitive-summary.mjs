function parsePath(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  const root = value.match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (!root) return null;
  const tail = value.slice(root.length);
  const pieces = [...tail.matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\]|\[\s*(\d+)\s*\]/g)];
  if (pieces.map(item => item[0]).join('').replace(/\s/g, '') !== tail.replace(/\s/g, '')) return null;
  return [root, ...pieces.map(item => item[1] ?? item[2] ?? String(Number(item[3])))];
}

function pathText(path) { return path?.join('.') ?? null; }

function instantiateArgument(argument, caller, callerContext) {
  const path = parsePath(argument?.expressionText);
  if (!path) return { expressionText: argument?.expressionText ?? null, resolved: false, path: null };
  const parameterIndex = caller.parameters.findIndex(parameter => parameter.name === path[0]);
  if (parameterIndex < 0) return { expressionText: pathText(path), path, resolved: true, origin: 'captured-or-global' };
  const binding = callerContext.argumentBindings?.[parameterIndex];
  if (!binding?.resolved || !binding.path) return { expressionText: argument.expressionText, path: null, resolved: false, origin: 'unresolved-parent-argument' };
  const substituted = [...binding.path, ...path.slice(1)];
  return { expressionText: pathText(substituted), path: substituted, resolved: true, origin: 'context-substitution' };
}

function buildBindings(callee, call, caller, callerContext) {
  return (callee.parameters ?? []).map(parameter => {
    const argument = call.arguments?.[parameter.index];
    const resolved = caller ? instantiateArgument(argument, caller, callerContext) : (() => {
      const path = parsePath(argument?.expressionText);
      return { path, expressionText: argument?.expressionText ?? null, resolved: Boolean(path), origin: 'root-argument' };
    })();
    return {
      parameterIndex: parameter.index, parameterName: parameter.name,
      argumentText: argument?.expressionText ?? null,
      resolvedArgument: resolved.expressionText,
      path: resolved.path,
      resolved: resolved.resolved,
      origin: resolved.origin ?? 'unresolved',
    };
  });
}

function substituteEffect(effect, callee, bindings, contextId, callId) {
  const path = [...(effect.path ?? [])];
  const index = (callee.parameters ?? []).findIndex(parameter => parameter.name === path[0]);
  if (index < 0) return { ...effect, path, contextId, callId, propagation: 'captured-or-global' };
  const binding = bindings[index];
  if (!binding?.resolved || !binding.path) return {
    ...effect, path, certainty: 'possible', contextId, callId, propagation: 'unresolved-context-argument',
  };
  const resolvedPath = [...binding.path, ...path.slice(1)];
  return { ...effect, path: resolvedPath, expression: pathText(resolvedPath), contextId, callId, propagation: 'context-sensitive-parameter-substitution' };
}

/**
 * Creates bounded call-string contexts for local helper summaries. Contexts are
 * per call path, so two invocations of one helper with different arguments do
 * not collapse into one parameter-substitution record.
 */
export function buildContextSensitiveSummary(functionSummaries = [], rootCallSites = [], options = {}) {
  const maxDepth = Math.max(1, Math.min(4, Number.isInteger(options.maxDepth) ? options.maxDepth : 2));
  const maxContexts = Math.max(1, Math.min(512, Number.isInteger(options.maxContexts) ? options.maxContexts : 64));
  const byId = new Map(functionSummaries.map(summary => [summary.functionId, summary]));
  const contexts = [];
  const diagnostics = [];
  const rootEffects = [];
  const queue = [];
  for (const call of rootCallSites) {
    const target = call.targetFunctionId ? byId.get(call.targetFunctionId) : null;
    if (!target) continue;
    queue.push({ target, call, parent: null, caller: null, callString: [call.callId], ancestors: [] });
  }
  const seen = new Set();
  while (queue.length && contexts.length < maxContexts) {
    const current = queue.shift();
    const { target, call, parent, caller, callString, ancestors } = current;
    const contextId = `ctx:${callString.slice(-maxDepth).join('>')}:${target.functionId}`;
    if (seen.has(contextId)) continue;
    seen.add(contextId);
    const bindings = buildBindings(target, call, caller, parent ?? { argumentBindings: [] });
    const directEffects = (target.effects ?? []).map(effect => substituteEffect(effect, target, bindings, contextId, call.callId));
    const context = {
      contextId, functionId: target.functionId, functionName: target.name,
      callId: call.callId, parentContextId: parent?.contextId ?? null,
      callString: callString.slice(-maxDepth), depth: callString.length,
      argumentBindings: bindings, directEffects, transitiveEffects: [...directEffects],
      purity: target.purity, returnFacts: (target.returns ?? []).map(item => ({
        expressionText: item.expressionText, value: item.value ?? null,
        dependencies: item.dependencies ?? [], sourceSpan: item.sourceSpan ?? null,
      })),
    };
    contexts.push(context);
    if (!parent) rootEffects.push(...directEffects);

    const nestedCalls = (target.calls ?? []).filter(item => item.resolvedSummaryId && byId.has(item.resolvedSummaryId));
    for (const nestedCall of nestedCalls) {
      const nestedTarget = byId.get(nestedCall.resolvedSummaryId);
      if (ancestors.includes(nestedTarget.functionId) || nestedTarget.functionId === target.functionId) {
        diagnostics.push({ code: 'CONTEXT_RECURSION_BOUNDARY', severity: 'warning', contextId, functionId: nestedTarget.functionId, callId: nestedCall.callId,
          message: 'Recursive context expansion stopped; the recursive summary remains conservative.' });
        context.transitiveEffects.push({ kind: 'unknown-recursive-effect', path: [], certainty: 'possible', contextId, callId: nestedCall.callId, propagation: 'recursive-context-boundary' });
        continue;
      }
      if (callString.length >= maxDepth) {
        diagnostics.push({ code: 'CONTEXT_DEPTH_LIMIT', severity: 'info', contextId, callId: nestedCall.callId, message: 'Nested helper context was not expanded beyond the configured call-string depth.' });
        continue;
      }
      queue.push({
        target: nestedTarget, call: nestedCall, parent: context, caller: target,
        callString: [...callString, nestedCall.callId], ancestors: [...ancestors, target.functionId],
      });
    }
  }
  if (queue.length) diagnostics.push({ code: 'CONTEXT_COUNT_LIMIT', severity: 'warning', message: `Context expansion stopped at ${maxContexts} contexts.` });

  const byContext = new Map(contexts.map(context => [context.contextId, context]));
  for (const context of [...contexts].reverse()) {
    for (const child of contexts.filter(item => item.parentContextId === context.contextId)) {
      context.transitiveEffects.push(...child.transitiveEffects);
    }
    const dedupe = new Map();
    for (const effect of context.transitiveEffects) {
      const key = JSON.stringify([effect.kind, effect.path, effect.certainty, effect.callId, effect.contextId]);
      if (!dedupe.has(key)) dedupe.set(key, effect);
    }
    context.transitiveEffects = [...dedupe.values()];
  }
  const immutableContexts = contexts.map(context => Object.freeze({
    ...context,
    callString: Object.freeze([...context.callString]),
    argumentBindings: Object.freeze(context.argumentBindings.map(item => Object.freeze({ ...item, path: item.path ? Object.freeze([...item.path]) : null }))),
    directEffects: Object.freeze(context.directEffects.map(item => Object.freeze(item))),
    transitiveEffects: Object.freeze(context.transitiveEffects.map(item => Object.freeze(item))),
    returnFacts: Object.freeze(context.returnFacts.map(item => Object.freeze(item))),
  }));
  return Object.freeze({
    schemaVersion: '1.0', algorithm: 'bounded-context-sensitive-call-string-summary',
    contexts: Object.freeze(immutableContexts),
    rootEffects: Object.freeze(immutableContexts.filter(item => !item.parentContextId).flatMap(item => item.transitiveEffects)),
    diagnostics: Object.freeze(diagnostics),
    limits: Object.freeze({ contextDepth: maxDepth, maxContexts, recursion: 'conservative-boundary', unresolvedArguments: 'possible-effects-only' }),
  });
}
