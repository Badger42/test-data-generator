/**
 * Composes bounded array-pipeline element mappings and upstream predicate
 * constraints. AST and solver operations are injected; no runtime composition
 * module is imported here.
 */
export function createArrayPipelineComposer(ports) {
  const {
    ts,
    comparatorMethods,
    getCallbackSingleReturnExpression,
    bindCallbackParameters,
    deriveMappedItemAlias,
    getCallbackPredicateSourceExpression,
    getNodeText,
    aliasPathText,
    aliasMetadata,
    inferComparatorOrder,
    comparatorOrderSolutions,
    getCallbackPredicateExpression,
    solveCondition,
    unsupportedSolution,
    combineSolutions,
  } = ports;

  function mapElementThroughStages(descriptor, sourceIndex, stageLimit, ctx) {
    const aliases = new Map(ctx.pathAliases);
    let currentAlias = { kind: 'path', path: [...descriptor.collectionPath, String(sourceIndex)] };
    const trace = [];
    const stages = (descriptor.pipeline ?? []).slice(0, stageLimit);

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const stage = stages[stageIndex];
      const inputAlias = currentAlias;
      if (stage.method === 'flat') {
        for (let level = 0; level < stage.depth; level += 1) {
          if (currentAlias?.kind === 'path') currentAlias = { kind: 'path', path: [...currentAlias.path, '0'] };
          else currentAlias = { kind: 'unknown' };
        }
        trace.push({
          index: stageIndex, method: 'flat', depth: stage.depth,
          input: aliasPathText(inputAlias), output: aliasPathText(currentAlias),
          cardinality: 'expands-nested-arrays',
          mappingAssumption: 'representative-first-child-per-source-element',
        });
        continue;
      }

      if (['reverse', 'toReversed'].includes(stage.method)) {
        const reversedIndex = 1 - sourceIndex;
        const remapped = mapElementThroughStages(descriptor, reversedIndex, stageIndex, ctx);
        currentAlias = remapped.alias;
        aliases.clear();
        for (const [name, alias] of remapped.aliases) aliases.set(name, alias);
        trace.push({
          index: stageIndex, method: stage.method,
          input: aliasPathText(inputAlias), output: aliasPathText(currentAlias),
          ordering: 'reversed', representativeLength: 2, sourceIndex: reversedIndex,
          mappingAssumption: 'two-element representative input; index mapping is reversed exactly for that shape',
        });
        continue;
      }

      if (stage.method === 'slice') {
        const start = stage.start ?? 0;
        if (start > 0 && currentAlias?.kind === 'path') {
          const nextPath = [...currentAlias.path];
          const last = Number(nextPath[nextPath.length - 1]);
          if (Number.isInteger(last)) nextPath[nextPath.length - 1] = String(last + start);
          currentAlias = { kind: 'path', path: nextPath };
        }
        trace.push({ index: stageIndex, method: 'slice', start, input: aliasPathText(inputAlias), output: aliasPathText(currentAlias), cardinality: 'may-shrink' });
        continue;
      }

      if (comparatorMethods.has(stage.method)) {
        trace.push({
          index: stageIndex, method: stage.method,
          input: aliasPathText(inputAlias), output: aliasPathText(currentAlias),
          ordering: 'identity-under-comparator-constraints',
          mutation: stage.method === 'sort' ? 'mutates-receiver' : 'returns-copy',
        });
        continue;
      }

      if (!stage.callback) continue;
      bindCallbackParameters(stage.callback, aliases, currentAlias, sourceIndex);
      if (stage.method === 'map') {
        const mapped = deriveMappedItemAlias(stage.callback, currentAlias, aliases) ?? { kind: 'unknown' };
        currentAlias = mapped;
        trace.push({ index: stageIndex, method: 'map', input: aliasPathText(inputAlias), output: aliasPathText(currentAlias), projection: aliasMetadata(mapped), cardinality: 'preserves-length' });
      } else if (stage.method === 'flatMap') {
        const mapped = deriveMappedItemAlias(stage.callback, currentAlias, aliases);
        currentAlias = mapped?.kind === 'path' ? { kind: 'path', path: [...mapped.path, '0'] } : { kind: 'unknown' };
        trace.push({
          index: stageIndex, method: 'flatMap', input: aliasPathText(inputAlias), output: aliasPathText(currentAlias),
          projection: mapped ? aliasMetadata(mapped) : null, cardinality: 'expands-zero-or-more',
          mappingAssumption: 'one-representative-first-child-per-source-element',
        });
      } else if (stage.method === 'filter') {
        trace.push({
          index: stageIndex, method: 'filter', input: aliasPathText(inputAlias), output: aliasPathText(currentAlias),
          predicate: getCallbackPredicateSourceExpression(stage.callback)?.getText(ctx.sourceFile) ?? null,
          cardinality: 'may-shrink', order: 'stable',
        });
      } else if (stage.method === 'reduce') {
        currentAlias = { kind: 'unknown' };
        trace.push({ index: stageIndex, method: 'reduce', input: aliasPathText(inputAlias), output: 'accumulator', cardinality: 'one-value', stateModel: 'separate-reducer-analysis' });
      }
    }
    return { alias: currentAlias, aliases, trace };
  }

  function getPipelineContext(descriptor, itemIndex, ctx, callbackIndex = itemIndex) {
    const filters = [];
    const trace = [];
    const pipeline = descriptor.pipeline ?? [];
    const requiresPair = pipeline.some(stage => comparatorMethods.has(stage.method) || ['reverse', 'toReversed'].includes(stage.method));
    const requiredSourceIndexes = Array.from({ length: Math.max(1, itemIndex + 1, requiresPair ? 2 : 1) }, (_, index) => index);

    // A filtered output at index N maps to source index N only when every prior
    // source item survives each upstream filter. Constrain every representative
    // source index 0..N to preserve that mapping.
    for (let stageIndex = 0; stageIndex < pipeline.length; stageIndex += 1) {
      const stage = pipeline[stageIndex];
      if (stage.method !== 'filter' || !stage.callback) continue;
      const predicate = getCallbackPredicateExpression(stage.callback);
      for (const sourceIndex of requiredSourceIndexes) {
        const prefix = mapElementThroughStages(descriptor, sourceIndex, stageIndex, ctx);
        const stageAliases = new Map(prefix.aliases);
        bindCallbackParameters(stage.callback, stageAliases, prefix.alias, sourceIndex);
        if (!predicate) {
          filters.push(unsupportedSolution('Chained filter() requires a simple inline predicate to model downstream elements.'));
        } else {
          filters.push(solveCondition(predicate, true, { ...ctx, pathAliases: stageAliases }));
        }
      }
    }

    // Construct the representative source already in comparator order. This
    // preserves tracked source identity without claiming arbitrary sort tracing.
    for (let stageIndex = 0; stageIndex < pipeline.length; stageIndex += 1) {
      const stage = pipeline[stageIndex];
      if (!comparatorMethods.has(stage.method) || !stage.callback) continue;
      const leftPrefix = mapElementThroughStages(descriptor, 0, stageIndex, ctx);
      const rightPrefix = mapElementThroughStages(descriptor, 1, stageIndex, ctx);
      const order = inferComparatorOrder(stage, leftPrefix.alias, rightPrefix.alias, ctx);
      if (!order) {
        filters.push(unsupportedSolution(`Cannot preserve downstream element identity through ${stage.method}(): comparator order is not recognized.`));
        trace.push({ index: stageIndex, method: stage.method, ordering: 'unknown', mappingAssumption: 'downstream item-to-source mapping is unsupported' });
        continue;
      }
      const orderSolutions = comparatorOrderSolutions(order, ctx);
      if (!orderSolutions.length) filters.push(unsupportedSolution(`Could not construct representative input order for ${stage.method}() comparator.`));
      else filters.push(orderSolutions);
      trace.push({
        index: stageIndex, method: stage.method, ordering: order.direction,
        comparatorEvidence: order.evidence,
        sortedKeys: { first: order.leftForm.path?.join('.') ?? 'constant', second: order.rightForm.path?.join('.') ?? 'constant' },
        assumption: 'input representatives are generated in comparator order so downstream indexes retain source identity',
      });
    }

    const target = mapElementThroughStages(descriptor, itemIndex, pipeline.length, ctx);
    const traceByIndex = new Map(target.trace.map(item => [item.index, item]));
    for (const item of trace) traceByIndex.set(item.index, { ...(traceByIndex.get(item.index) ?? {}), ...item });
    const pipelineTrace = pipeline.map((stage, index) => {
      const existing = traceByIndex.get(index);
      if (existing) return existing;
      return {
        index, method: stage.method,
        callback: stage.callback ? getNodeText(getCallbackSingleReturnExpression(stage.callback) ?? stage.callback.body, ctx.sourceFile) : null,
        input: 'tracked element', output: 'tracked element', dataflow: 'identity',
      };
    });

    const filterSolutions = filters.reduce((combined, solutions) => combineSolutions(combined, solutions, ctx.maxAlternatives), [
      { assignments: new Map(), unsupported: [] },
    ]);
    const aliasesForFinalCallback = new Map(target.aliases);
    const [itemParameter, indexParameter] = descriptor.callback.parameters;
    if (itemParameter && ts.isIdentifier(itemParameter.name)) aliasesForFinalCallback.set(itemParameter.name.text, target.alias);
    if (indexParameter && ts.isIdentifier(indexParameter.name)) aliasesForFinalCallback.set(indexParameter.name.text, { kind: 'constant', value: callbackIndex });
    return {
      aliases: aliasesForFinalCallback,
      itemAlias: target.alias,
      filterSolutions,
      trace: pipelineTrace,
      requiredSourceIndexes,
    };
  }

  return Object.freeze({ mapElementThroughStages, getPipelineContext });
}
