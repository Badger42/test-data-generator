const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));

function normalizePath(path) {
  if (Array.isArray(path)) return path.map(String);
  if (typeof path === 'string') return path.split('.').filter(Boolean);
  return [];
}

function entriesOf(assignments) {
  if (assignments instanceof Map) return [...assignments.values()];
  if (Array.isArray(assignments)) return assignments;
  if (assignments && typeof assignments[Symbol.iterator] === 'function') return [...assignments];
  return [];
}

function overlaps(a, b) {
  if (!a || !b || a.file && b.file && a.file !== b.file) return false;
  const aStart = a.startOffset ?? -1;
  const aEnd = a.endOffset ?? aStart;
  const bStart = b.startOffset ?? -1;
  const bEnd = b.endOffset ?? bStart;
  return aStart <= bEnd && bStart <= aEnd;
}

function sameOrNested(left, right) {
  if (!left.length || !right.length) return false;
  const min = Math.min(left.length, right.length);
  return left.slice(0, min).every((part, index) => part === right[index]);
}

function pathFromEffect(effect) {
  return normalizePath(effect?.path ?? effect?.expression);
}

/**
 * Produces auditable, per-scenario Data Flow evidence. Evidence is deliberately
 * descriptive: static facts can support a candidate but never claim runtime
 * verification. Missing/ambiguous facts are omitted rather than fabricated.
 */
export function createDataFlowEvidenceBuilder() {
  function build(input = {}) {
    const model = input.dataFlowModel;
    if (!model) return [];
    const evidence = [];
    const seen = new Set();
    const targetSpan = input.sourceSpan ?? input.target?.sourceSpan ?? null;
    const push = item => {
      const key = JSON.stringify([item.source, item.status, item.message, item.sourceSpan?.startOffset ?? null]);
      if (seen.has(key)) return;
      seen.add(key);
      evidence.push(item);
    };

    for (const assignment of entriesOf(input.assignments)) {
      const path = normalizePath(assignment?.path);
      if (!path.length) continue;
      const [rootName, ...segments] = path;
      const property = (model.properties ?? []).find(item => item.path?.rootName === rootName &&
        JSON.stringify(normalizePath(item.path?.segments)) === JSON.stringify(segments));
      if (property) {
        const confidence = property.confidence === 'declared' ? 0.98 : property.confidence === 'high' ? 0.9 :
          property.confidence === 'medium' ? 0.7 : property.confidence === 'heuristic' ? 0.55 : 0.3;
        push({ source: 'static-analysis', status: confidence >= 0.7 ? 'candidate' : 'ambiguous', confidence,
          message: `Assignment ${path.join('.')} is supported by property/type evidence (${property.kind}, ${property.confidence}).` });
      }

      const matchingMemory = (model.memorySsa?.locations ?? []).filter(location => location.rootName === rootName &&
        (sameOrNested(normalizePath(location.path), segments) || sameOrNested(segments, normalizePath(location.path))));
      for (const location of matchingMemory) {
        const accesses = (model.memorySsa?.accesses ?? []).filter(access => access.location === location.id &&
          (!targetSpan || !access.sourceSpan || overlaps(targetSpan, access.sourceSpan)));
        if (accesses.length) push({ source: 'static-analysis', status: 'candidate', confidence: 0.85,
          message: `Assignment ${path.join('.')} intersects ${accesses.length} field-sensitive memory access(es) in the analyzed path.`,
          ...(accesses[0].sourceSpan ? { sourceSpan: accesses[0].sourceSpan } : {}) });
      }

      const symbolIds = Object.entries(model.pointsTo?.symbols ?? {}).filter(([, name]) => name === rootName).map(([id]) => id);
      const aliasRelations = (model.pointsTo?.aliasPairs ?? []).filter(pair => symbolIds.includes(pair.leftSymbolId) || symbolIds.includes(pair.rightSymbolId));
      if (aliasRelations.length) push({ source: 'static-analysis', status: aliasRelations.every(item => item.relation === 'must-alias') ? 'candidate' : 'ambiguous',
        confidence: aliasRelations.every(item => item.relation === 'must-alias') ? 0.9 : 0.55,
        message: `Assignment ${path.join('.')} has ${aliasRelations.length} points-to alias relation(s); may-alias relations remain conservative.` });

      const pipelineMatches = (model.arrayPipelineFlow?.pipelines ?? []).filter(pipeline => {
        const collection = normalizePath(pipeline.collectionPath ?? pipeline.collection);
        return sameOrNested(collection, path) || sameOrNested(path, collection);
      });
      for (const pipeline of pipelineMatches) {
        push({ source: 'static-analysis', status: pipeline.provenance?.exactSourceIndexMapping ? 'candidate' : 'ambiguous',
          confidence: pipeline.provenance?.exactSourceIndexMapping ? 0.9 : 0.55,
          message: `Assignment ${path.join('.')} is related to Array Pipeline ${pipeline.id}; ${pipeline.warnings?.length ?? 0} provenance warning(s) remain.` });
      }

      const effects = [
        ...(model.interprocedural?.rootEffects ?? []),
        ...(model.interprocedural?.contextSensitive?.rootEffects ?? []),
      ].filter(effect => sameOrNested(pathFromEffect(effect), path) || sameOrNested(path, pathFromEffect(effect)));
      if (effects.length) push({ source: 'static-analysis', status: effects.every(item => item.certainty === 'definite') ? 'candidate' : 'ambiguous',
        confidence: effects.every(item => item.certainty === 'definite') ? 0.9 : 0.5,
        message: `Assignment ${path.join('.')} is connected to ${effects.length} interprocedural effect(s).` });
    }

    if (targetSpan) {
      const useBindings = model.ssa?.versioned?.useBindings ?? [];
      const versionedUses = useBindings.filter(binding => (binding.occurrences ?? []).some(occurrence => overlaps(targetSpan, occurrence)));
      if (versionedUses.length) {
        const unresolved = versionedUses.filter(binding => !binding.value);
        push({ source: 'static-analysis', status: unresolved.length ? 'ambiguous' : 'candidate',
          confidence: unresolved.length ? 0.45 : 0.9,
          sourceSpan: targetSpan,
          message: `${versionedUses.length} SSA use binding(s) are associated with this target; ${unresolved.length} unresolved.` });
      }
      const loop = (model.loopFlow?.loops ?? []).find(item => item.nodeIds?.some(nodeId => {
        const node = model.controlFlowGraph?.nodes?.find(candidate => candidate.id === nodeId);
        return node?.sourceSpan && overlaps(targetSpan, node.sourceSpan);
      }));
      if (loop) push({ source: 'static-analysis', status: loop.confidence === 'medium' ? 'candidate' : 'ambiguous',
        confidence: loop.confidence === 'medium' ? 0.75 : 0.45, sourceSpan: targetSpan,
        message: `Target is inside ${loop.kind}; loop-carried state is ${loop.stateTransfer}.` });
    }

    for (const warning of model.warnings ?? []) {
      if (warning.severity === 'error' || (targetSpan && warning.sourceSpan && overlaps(targetSpan, warning.sourceSpan))) {
        push({ source: 'static-analysis', status: 'ambiguous', confidence: 0.25,
          ...(warning.sourceSpan ? { sourceSpan: warning.sourceSpan } : {}),
          message: `Data Flow limitation: ${warning.message}` });
      }
    }

    return Object.freeze(evidence.map(item => Object.freeze(item)));
  }

  return Object.freeze({ build });
}
