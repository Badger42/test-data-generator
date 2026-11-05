function parseStaticPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const source = value.trim();
  const root = source.match(/^[A-Za-z_$][\w$]*/)?.[0];
  if (!root) return null;
  const tail = source.slice(root.length);
  const tokens = [...tail.matchAll(/\.\s*([A-Za-z_$][\w$]*)|\[\s*(\d+|['"][^'"]+['"])\s*\]/g)];
  if (tokens.map(match => match[0]).join('').replace(/\s/g, '') !== tail.replace(/\s/g, '')) return null;
  const segments = [root];
  for (const match of tokens) {
    const raw = match[1] ?? match[2];
    segments.push(/^\d+$/.test(raw) ? Number(raw) : raw.replace(/^['"]|['"]$/g, ''));
  }
  return segments;
}

function methodSemantics(method) {
  switch (method) {
    case 'filter': return { cardinality: 'may-shrink', elementIdentity: 'preserved', order: 'stable', mutatesInput: false };
    case 'map': return { cardinality: 'preserved', elementIdentity: 'transformed', order: 'stable', mutatesInput: false };
    case 'flatMap': return { cardinality: 'expands-or-shrinks', elementIdentity: 'derived', order: 'callback-order', mutatesInput: false };
    case 'flat': return { cardinality: 'may-shrink-or-expand', elementIdentity: 'derived', order: 'stable', mutatesInput: false };
    case 'sort': return { cardinality: 'preserved', elementIdentity: 'preserved', order: 'reordered', mutatesInput: true };
    case 'toSorted': return { cardinality: 'preserved', elementIdentity: 'preserved', order: 'reordered', mutatesInput: false };
    case 'reverse':
    case 'toReversed': return { cardinality: 'preserved', elementIdentity: 'preserved', order: 'reversed', mutatesInput: method === 'reverse' };
    case 'slice': return { cardinality: 'may-shrink', elementIdentity: 'preserved', order: 'stable', mutatesInput: false };
    case 'find':
    case 'findLast': return { cardinality: 'zero-or-one', elementIdentity: 'preserved', order: 'short-circuit', mutatesInput: false };
    case 'findIndex':
    case 'findLastIndex': return { cardinality: 'single-index', elementIdentity: 'not-applicable', order: 'short-circuit', mutatesInput: false };
    case 'some':
    case 'every': return { cardinality: 'boolean', elementIdentity: 'not-applicable', order: 'short-circuit', mutatesInput: false };
    case 'reduce': return { cardinality: 'aggregate', elementIdentity: 'derived', order: 'iteration-order', mutatesInput: false };
    default: return { cardinality: 'unknown', elementIdentity: 'unknown', order: 'unknown', mutatesInput: false };
  }
}

function indexTransform(stage, collection) {
  const method = stage.method;
  const predicate = stage.predicate ?? stage.callback ?? null;
  const start = Number.isInteger(stage.start) ? stage.start : 0;
  const end = Number.isInteger(stage.end) ? stage.end : null;
  const length = Number.isInteger(stage.representativeLength) ? stage.representativeLength : null;
  switch (method) {
    case 'map':
    case 'forEach':
      return { kind: 'identity', sourceToOutput: 'i', outputToSource: 'i', exact: true, oneToOne: true };
    case 'filter':
      return {
        kind: 'filtered-rank',
        sourceToOutput: `count(j => (${predicate ?? 'predicate(j)'}) for 0 <= j <= i) - 1`,
        outputToSource: `selectSourceIndexByPredicateRank(${predicate ?? 'predicate'}, i)`,
        exact: false, oneToOne: false, condition: predicate,
      };
    case 'slice':
      if (start < 0 || (end !== null && end < 0)) {
        const base = stage.input ?? collection;
        return {
          kind: 'slice-relative-offset',
          sourceToOutput: `i - max(0, length(${base}) + (${start}))`,
          outputToSource: `i + max(0, length(${base}) + (${start}))`,
          exact: false, oneToOne: true, relativeToLength: true,
        };
      }
      return {
        kind: 'slice-offset', sourceToOutput: `i - (${start})`,
        outputToSource: `i + (${start})`, exact: true, oneToOne: true,
        sourceLowerBound: start, sourceUpperBound: end,
      };
    case 'reverse':
    case 'toReversed':
      return {
        kind: 'reverse', sourceToOutput: length === null ? `length(${collection}) - 1 - i` : `${length - 1} - i`,
        outputToSource: length === null ? `length(${collection}) - 1 - i` : `${length - 1} - i`,
        exact: true, oneToOne: true, lengthKnown: length !== null,
      };
    case 'sort':
    case 'toSorted':
      return { kind: 'comparator-permutation', sourceToOutput: 'rankByComparator(i)', outputToSource: 'inverseComparatorPermutation(i)', exact: false, oneToOne: true, comparator: stage.comparatorEvidence ?? null };
    case 'flatMap':
      return { kind: 'flat-map-prefix-sum', sourceToOutput: 'sum(childCount(j), 0 <= j < i) + childIndex', outputToSource: 'sourceIndexByChildPrefixSum(i)', exact: false, oneToOne: false, representativeChild: 0 };
    case 'flat':
      return { kind: 'flatten-prefix-sum', sourceToOutput: 'flattenOffset(sourceIndex, nestedIndex)', outputToSource: 'nestedCoordinateByFlattenedIndex(i)', exact: false, oneToOne: false, depth: stage.depth ?? 1 };
    case 'find':
    case 'findLast':
    case 'findIndex':
    case 'findLastIndex':
      return { kind: 'predicate-selection', sourceToOutput: 'selectedByPredicate(i)', outputToSource: `firstMatchingSourceIndex(${predicate ?? 'predicate'})`, exact: false, oneToOne: false, direction: method.startsWith('findLast') ? 'reverse' : 'forward', condition: predicate };
    case 'some':
    case 'every':
    case 'reduce':
      return { kind: 'aggregate', sourceToOutput: null, outputToSource: null, exact: false, oneToOne: false };
    default:
      return { kind: 'unknown', sourceToOutput: null, outputToSource: null, exact: false, oneToOne: false };
  }
}

function composeSourceIndex(sourceIndex, stages) {
  let expression = String(sourceIndex);
  const trace = [];
  let exact = true;
  let oneToOne = true;
  let excluded = false;
  for (const stage of stages) {
    const transform = stage.indexTransform;
    if (transform.kind === 'slice-offset') {
      // A slice bound is expressed in the immediately preceding stage's index
      // space. Compare it with the original source index only while the full
      // prefix is still an exact identity mapping; otherwise keep exclusion
      // symbolic instead of dropping a source element incorrectly.
      if (exact && Number.isInteger(transform.sourceLowerBound) && sourceIndex < transform.sourceLowerBound) excluded = true;
      if (exact && Number.isInteger(transform.sourceUpperBound) && sourceIndex >= transform.sourceUpperBound) excluded = true;
      expression = `(${expression}) - (${Number.isInteger(stage.start) ? stage.start : 0})`;
    } else if (transform.kind === 'slice-relative-offset') {
      expression = `(${expression}) - max(0, length(${stage.input ?? 'collection'}) + (${Number.isInteger(stage.start) ? stage.start : 0}))`;
    } else if (transform.kind === 'reverse') {
      expression = transform.lengthKnown
        ? `(${stage.representativeLength - 1}) - (${expression})`
        : `length(${stage.input ?? 'collection'}) - 1 - (${expression})`;
    } else if (transform.kind === 'filtered-rank') {
      expression = `rankAfterFilter(${expression}, ${JSON.stringify(transform.condition)})`;
    } else if (transform.kind === 'comparator-permutation') {
      expression = `rankByComparator(${expression})`;
    } else if (transform.kind === 'flat-map-prefix-sum') {
      expression = `prefixChildCount(${expression}) + childIndex`;
    } else if (transform.kind === 'flatten-prefix-sum') {
      expression = `flattenOffset(${expression}, nestedIndex)`;
    } else if (transform.kind === 'predicate-selection' || transform.kind === 'aggregate' || transform.kind === 'unknown') {
      expression = null;
    }
    exact &&= transform.exact;
    oneToOne &&= transform.oneToOne;
  }
  if (excluded) expression = null;
  return { sourceIndex, outputIndexExpression: expression, exact, oneToOne, excluded, stageKinds: stages.map(stage => stage.indexTransform.kind) };
}

/**
 * Builds stage-level element and index provenance. Exactness is claimed only
 * for transformations with an explicit bijective/static mapping; filter rank,
 * comparator permutation and flattening remain symbolic/non-exact.
 */
export function buildArrayPipelineDataFlow(pipelines = []) {
  const models = pipelines.map(pipeline => {
    const stages = (pipeline.stages ?? []).map((stage, position) => {
      const semantics = methodSemantics(stage.method);
      const inputPath = parseStaticPath(stage.input);
      const outputPath = parseStaticPath(stage.output);
      const transform = indexTransform(stage, pipeline.collection);
      return {
        id: `${pipeline.id}:stage:${stage.index ?? position}`,
        index: stage.index ?? position,
        method: stage.method ?? 'unknown', role: stage.role ?? 'transform',
        input: stage.input ?? null, output: stage.output ?? null,
        inputPath, outputPath,
        predicate: stage.predicate ?? null, callback: stage.callback ?? null,
        projection: stage.projection ?? null, comparatorEvidence: stage.comparatorEvidence ?? null,
        cardinality: stage.cardinality ?? semantics.cardinality,
        elementIdentity: semantics.elementIdentity,
        order: stage.order ?? stage.ordering ?? semantics.order,
        mutatesInput: stage.mutation === 'mutates-receiver' || semantics.mutatesInput,
        sourcePositionAligned: transform.kind === 'identity',
        indexTransform: transform,
        confidence: stage.assumption || stage.mappingAssumption ? 'bounded' : 'structural',
        assumptions: [stage.assumption, stage.mappingAssumption].filter(Boolean),
      };
    });
    const edges = [];
    for (let index = 1; index < stages.length; index += 1) {
      const previous = stages[index - 1];
      const current = stages[index];
      edges.push({
        from: previous.id, to: current.id,
        kind: previous.indexTransform.kind === 'flat-map-prefix-sum' || previous.indexTransform.kind === 'flatten-prefix-sum'
          ? 'element-provenance-after-expansion'
          : previous.indexTransform.kind === 'comparator-permutation' || previous.indexTransform.kind === 'reverse'
            ? 'element-provenance-after-reordering' : 'collection-flow',
        composedIndexRelation: current.indexTransform.kind === 'identity' ? previous.indexTransform.kind : `${previous.indexTransform.kind}->${current.indexTransform.kind}`,
      });
    }
    const collectionPath = parseStaticPath(pipeline.collection);
    const elementPath = Array.isArray(pipeline.elementAlias?.path) ? [...pipeline.elementAlias.path] : null;
    const requiredSourceIndexes = [...new Set(pipeline.requiredSourceIndexes ?? [])].filter(Number.isInteger).sort((a, b) => a - b);
    const sourceMappings = requiredSourceIndexes.map(index => ({
      ...composeSourceIndex(index, stages),
      sourcePath: collectionPath ? [...collectionPath, index] : null,
      representativeOutputPath: elementPath,
    }));
    const constraints = stages.flatMap(stage => [
      ...(stage.predicate ? [{ stageId: stage.id, kind: 'predicate', expression: stage.predicate }] : []),
      ...(stage.callback ? [{ stageId: stage.id, kind: 'callback', expression: stage.callback }] : []),
      ...(stage.comparatorEvidence ? [{ stageId: stage.id, kind: 'comparator', expression: stage.comparatorEvidence }] : []),
    ]);
    const warnings = [...(pipeline.warnings ?? [])];
    for (const stage of stages) {
      if (!stage.indexTransform.exact || !stage.indexTransform.oneToOne) {
        warnings.push(`Stage ${stage.index} (${stage.method}) has symbolic/non-bijective index provenance (${stage.indexTransform.kind}).`);
      }
    }
    return {
      id: pipeline.id, sourceExpression: pipeline.sourceExpression,
      collection: pipeline.collection, collectionPath, resultKind: pipeline.resultKind,
      stages, edges, constraints, sourceMappings,
      elementAlias: pipeline.elementAlias ?? null,
      assumptions: [...new Set([...(pipeline.assumptions ?? []), ...stages.flatMap(stage => stage.assumptions)])],
      warnings: [...new Set(warnings)],
      provenance: {
        kind: 'composed-index-and-element-provenance',
        completeForGeneralRuntime: false,
        requiredSourceIndexes,
        exactSourceIndexMapping: sourceMappings.length > 0 && sourceMappings.every(item => item.exact && !item.excluded),
        symbolicMappings: sourceMappings.filter(item => item.outputIndexExpression && !item.exact).length,
      },
    };
  });
  return Object.freeze({
    schemaVersion: '1.1', pipelines: Object.freeze(models),
    pipelineCount: models.length,
    stageCount: models.reduce((total, item) => total + item.stages.length, 0),
    limits: Object.freeze({
      arbitrarySortPermutation: 'symbolic-rank-only', filterIndexRemapping: 'predicate-rank-expression', negativeSliceBounds: 'relative-to-immediately-preceding-collection-length',
      flatMapExpansion: 'prefix-child-count-symbolic', flatNesting: 'symbolic-flatten-offset',
      callbackExecution: 'not-executed', dynamicCardinality: 'not-proven',
    }),
  });
}
