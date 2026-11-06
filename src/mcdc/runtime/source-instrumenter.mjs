import { RUNTIME_MCDC_SYMBOL } from './runtime-recorder.mjs';

export function createMcdcSourceInstrumenter({ ts, getScriptKindForRuntimeInstrumentation, findNodeForSourceRange, inspectRuntimeExpression }) {
  if (!ts || !getScriptKindForRuntimeInstrumentation || !findNodeForSourceRange || !inspectRuntimeExpression) {
    throw new TypeError('MC/DC source instrumenter requires TypeScript and AST inspection ports');
  }
  return function instrumentMcdcSource(sourceFile, sourceText, functionResults) {

    const sourceFileNode = ts.createSourceFile(
      sourceFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKindForRuntimeInstrumentation(sourceFile),
    );
    const spans = [];
    const instrumentation = {
      enabled: true,
      symbol: RUNTIME_MCDC_SYMBOL,
      decisionsDiscovered: 0,
      decisionsInstrumented: 0,
      conditionsDiscovered: 0,
      conditionsInstrumented: 0,
      skipped: [],
      insertionEvents: [],
    };

    function addSpan(kind, decisionId, conditionId, range, expression) {
      instrumentation[kind === 'decision' ? 'decisionsDiscovered' : 'conditionsDiscovered'] += 1;
      if (!range || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset) ||
          range.startOffset < 0 || range.endOffset <= range.startOffset || range.endOffset > sourceText.length) {
        instrumentation.skipped.push({ decisionId, conditionId: conditionId ?? null, kind, reason: 'Missing or invalid source range.' });
        return;
      }
      const node = findNodeForSourceRange(sourceFileNode, range.startOffset, range.endOffset);
      if (!node) {
        instrumentation.skipped.push({ decisionId, conditionId: conditionId ?? null, kind, reason: 'Source AST node could not be resolved from the stored range.' });
        return;
      }
      const features = inspectRuntimeExpression(node);
      if (features.hasYield) {
        instrumentation.skipped.push({ decisionId, conditionId: conditionId ?? null, kind, reason: 'Yield expressions cannot be wrapped without changing generator semantics.' });
        return;
      }
      if (features.hasDirectEval) {
        instrumentation.skipped.push({ decisionId, conditionId: conditionId ?? null, kind, reason: 'Direct eval is not instrumented because wrapping changes its lexical scope.' });
        return;
      }
      if (features.hasAwait && !features.asyncContext) {
        instrumentation.skipped.push({ decisionId, conditionId: conditionId ?? null, kind, reason: 'Await expression has no async function context for safe instrumentation.' });
        return;
      }
      const key = JSON.stringify(decisionId);
      const asyncPrefix = features.hasAwait ? 'await ' : '';
      const helper = `globalThis[Symbol.for(${JSON.stringify(RUNTIME_MCDC_SYMBOL)})]`;
      const prefix = kind === 'decision'
        ? `${asyncPrefix}${helper}.${features.hasAwait ? 'decisionAsync' : 'decision'}(${key}, ${features.hasAwait ? 'async ' : ''}() => (`
        : `${asyncPrefix}${helper}.${features.hasAwait ? 'conditionAsync' : 'condition'}(${key}, ${JSON.stringify(conditionId)}, ${features.hasAwait ? 'async ' : ''}() => (`;
      spans.push({
        kind, decisionId, conditionId: conditionId ?? null,
        start: range.startOffset, end: range.endOffset,
        prefix, suffix: '))',
        expression: expression ?? sourceText.slice(range.startOffset, range.endOffset),
        async: features.hasAwait,
      });
      instrumentation[kind === 'decision' ? 'decisionsInstrumented' : 'conditionsInstrumented'] += 1;
    }

    for (const fn of functionResults) {
      for (const decision of fn.mcdc?.decisions ?? []) {
        addSpan('decision', decision.decisionId, null, decision.runtimeExpressionRange, decision.expression);
        for (const condition of decision.conditions ?? []) {
          addSpan('condition', decision.decisionId, condition.id, condition.runtimeExpressionRange, condition.expression);
        }
      }
    }

    // All spans should be disjoint or properly nested. Crossing spans indicate
    // that an expanded alias cannot be faithfully represented by source edits.
    const orderedSpans = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
    for (let index = 0; index < orderedSpans.length; index += 1) {
      const current = orderedSpans[index];
      for (let nextIndex = index + 1; nextIndex < orderedSpans.length; nextIndex += 1) {
        const next = orderedSpans[nextIndex];
        if (next.start >= current.end) break;
        const nested = next.end <= current.end;
        if (!nested && current.start !== next.start) {
          instrumentation.skipped.push({ decisionId: current.decisionId, conditionId: current.conditionId, kind: current.kind, reason: `Overlapping instrumentation ranges with ${next.decisionId}/${next.conditionId ?? next.kind}.` });
          current.invalid = true;
          next.invalid = true;
        }
      }
    }
    const validSpans = spans.filter(span => !span.invalid);
    if (validSpans.length !== spans.length) {
      instrumentation.decisionsInstrumented = validSpans.filter(span => span.kind === 'decision').length;
      instrumentation.conditionsInstrumented = validSpans.filter(span => span.kind === 'condition').length;
    }

    const opens = new Map();
    const closes = new Map();
    for (const span of validSpans) {
      if (!opens.has(span.start)) opens.set(span.start, []);
      if (!closes.has(span.end)) closes.set(span.end, []);
      opens.get(span.start).push(span);
      closes.get(span.end).push(span);
    }
    const positions = [...new Set([...opens.keys(), ...closes.keys()])].sort((a, b) => a - b);
    let cursor = 0;
    let generated = '';
    const insertionEvents = [];
    for (const position of positions) {
      generated += sourceText.slice(cursor, position);
      // The outer decision wrapper must open before an atom wrapper at the same
      // range. Longer same-start spans are also outermost.
      const startItems = (opens.get(position) ?? []).sort((a, b) =>
        (a.kind === 'decision' ? -1 : 1) - (b.kind === 'decision' ? -1 : 1) || b.end - a.end);
      for (const span of startItems) {
        const generatedStart = generated.length;
        generated += span.prefix;
        insertionEvents.push({ generatedStart, generatedEnd: generated.length, originalOffset: position });
      }
      const endItems = (closes.get(position) ?? []).sort((a, b) =>
        b.start - a.start || (a.kind === 'condition' ? -1 : 1));
      for (const span of endItems) {
        const generatedStart = generated.length;
        generated += span.suffix;
        insertionEvents.push({ generatedStart, generatedEnd: generated.length, originalOffset: position });
      }
      cursor = position;
    }
    generated += sourceText.slice(cursor);
    instrumentation.insertionEvents = insertionEvents;
    instrumentation.enabled = validSpans.length > 0;
    instrumentation.instrumentedSourceLength = generated.length;
    // Required by the Istanbul/V8 coordinate remapper. Keep this internal to
    // the execution pass; report serialization projects selected metadata only.
    instrumentation.generatedSource = generated;
    instrumentation.originalSourceLength = sourceText.length;
    return { source: generated, instrumentation };
  };
}
