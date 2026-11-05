import { getIdentifierSymbol, getSourceSpan, isNestedFunction, readStaticPath, unwrapExpression } from '../ast-utils.mjs';
import { buildCytronSsa } from './cytron-ssa-builder.mjs';

function rootIdentifier(node, ts) {
  let current = node;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  return current && ts.isIdentifier(current) ? current : null;
}

function pathForAccess(node, ts) {
  const path = readStaticPath(node, ts);
  if (path) return path;
  const current = unwrapExpression(node, ts);
  if (!ts.isElementAccessExpression(current)) return null;
  const parent = readStaticPath(current.expression, ts);
  return parent ? { ...parent, segments: [...parent.segments, '*'] } : null;
}

function enclosingCfgNode(node, graph, sourceFile) {
  const start = node?.getStart?.(sourceFile);
  if (!Number.isInteger(start)) return null;
  const candidates = graph.nodes.filter(item => item.sourceSpan && item.sourceSpan.startOffset <= start && item.sourceSpan.endOffset >= (node.getEnd?.() ?? start));
  candidates.sort((a, b) => {
    const aSize = a.sourceSpan.endOffset - a.sourceSpan.startOffset;
    const bSize = b.sourceSpan.endOffset - b.sourceSpan.startOffset;
    return aSize - bSize || a.id.localeCompare(b.id);
  });
  if (candidates.length) return candidates[0].id;
  const exact = graph.nodes.find(item => item.sourceSpan?.startOffset === start);
  return exact?.id ?? null;
}

function aliasAt(aliasFacts, symbolId, offset) {
  return (aliasFacts ?? []).filter(item => item.symbolId === symbolId && (item.sourceSpan?.startOffset ?? -1) <= offset)
    .sort((a, b) => (b.sourceSpan?.startOffset ?? -1) - (a.sourceSpan?.startOffset ?? -1))[0] ?? null;
}

function resolveLocation(rootInfo, path, alias) {
  const isMustAlias = alias?.relation === 'must-alias' && alias?.immutable === true;
  if (isMustAlias && alias.targetRootSymbolId) {
    return {
      rootSymbolId: alias.targetRootSymbolId, rootName: alias.targetPath?.[0] ?? path.rootName,
      segments: [...(alias.targetPath?.slice(1) ?? []), ...path.segments], aliasRelation: 'must-alias',
    };
  }
  return {
    rootSymbolId: rootInfo.symbolId, rootName: path.rootName, segments: path.segments,
    aliasRelation: alias?.relation ?? null,
    possibleTarget: alias?.targetRootSymbolId ? {
      rootSymbolId: alias.targetRootSymbolId, rootName: alias.targetPath?.[0] ?? path.rootName,
      segments: [...(alias.targetPath?.slice(1) ?? []), ...path.segments],
    } : null,
  };
}

function locationKey(rootSymbolId, segments) {
  return `heap:${rootSymbolId}:${JSON.stringify(segments)}`;
}
function isPrefix(left, right) { return left.length <= right.length && left.every((value, index) => value === right[index]); }
function pathsOverlap(left, right) { return isPrefix(left, right) || isPrefix(right, left) || left.includes('*') || right.includes('*'); }

/**
 * Resolve a local object access path onto its allocation-site identity. This
 * makes `child.value` and `holder.child.value` share one memory location when
 * points-to proves that `holder.child` contains the same object as `child`.
 * External parameters and ambiguous/unknown targets retain their symbolic
 * parameter paths instead of being collapsed.
 */
function resolveAllocationLocations(rootSymbolId, path, pointsToAnalysis) {
  if (!pointsToAnalysis || !rootSymbolId || !Array.isArray(path) || !path.length) return null;
  const allocationById = new Map((pointsToAnalysis.allocations ?? []).map(item => [item.id, item]));
  const initialSites = pointsToAnalysis.pointsTo?.[rootSymbolId] ?? [];
  const unknownSymbols = new Set(pointsToAnalysis.unknownSymbols ?? []);
  const unknownFields = new Set(pointsToAnalysis.unknownHeapFields ?? []);
  if (unknownSymbols.has(rootSymbolId) || !initialSites.length || initialSites.some(site => allocationById.get(site)?.external !== false)) return null;
  let currentSites = [...initialSites];
  let consumed = 0;
  const heapFields = pointsToAnalysis.heapFields ?? {};
  while (consumed < path.length - 1) {
    const next = new Set();
    for (const site of currentSites) {
      const memberKey = `${site}::${String(path[consumed])}`;
      const wildcardKey = `${site}::*`;
      if (unknownFields.has(memberKey) || unknownFields.has(wildcardKey)) return null;
      for (const target of heapFields[memberKey] ?? []) next.add(target);
      for (const target of heapFields[wildcardKey] ?? []) next.add(target);
    }
    if (!next.size || [...next].some(site => allocationById.get(site)?.external !== false)) break;
    currentSites = [...next];
    consumed += 1;
  }
  const namesBySite = new Map();
  for (const [symbolId, sites] of Object.entries(pointsToAnalysis.pointsTo ?? {})) {
    for (const site of sites) {
      const name = pointsToAnalysis.symbols?.[symbolId];
      if (!name) continue;
      const names = namesBySite.get(site) ?? [];
      names.push(name); namesBySite.set(site, names);
    }
  }
  const ambiguous = initialSites.length !== 1 || currentSites.length !== 1;
  return currentSites.map(siteId => ({
    allocationSiteId: siteId,
    rootSymbolId: siteId,
    rootName: [...(namesBySite.get(siteId) ?? [])].sort()[0] ?? `object@${allocationById.get(siteId)?.sourceSpan?.startLine ?? 'unknown'}`,
    path: path.slice(consumed),
    certainty: ambiguous ? 'possible' : 'definite',
    pointerResolution: 'allocation-site',
  }));
}

function canonicalizePointsToAccess(access, pointsToAnalysis) {
  const locations = resolveAllocationLocations(access.rootSymbolId ?? access.symbolId, access.path, pointsToAnalysis);
  if (!locations) return [access];
  return locations.map(location => ({
    ...access,
    symbolId: location.rootSymbolId,
    rootSymbolId: location.rootSymbolId,
    rootName: location.rootName,
    path: location.path,
    locationKey: locationKey(location.rootSymbolId, location.path),
    certainty: location.certainty === 'possible' ? 'possible' : access.certainty,
    pointerResolution: location.pointerResolution,
    allocationSiteId: location.allocationSiteId,
  }));
}

function collectReads(functionNode, ts, checker, sourceFile, graph, aliasFacts, relativeFile) {
  const accesses = [];
  const seen = new Set();
  const add = (node, readNode = node, pathNode = readNode) => {
    const path = pathForAccess(pathNode, ts);
    const root = rootIdentifier(pathNode, ts);
    const rootInfo = root && getIdentifierSymbol(root, ts, checker);
    if (!path || !rootInfo) return;
    const resolved = resolveLocation(rootInfo, path, aliasAt(aliasFacts, rootInfo.symbolId, node.getStart?.(sourceFile) ?? Number.MAX_SAFE_INTEGER));
    if (!resolved.rootSymbolId) return;
    const cfgNodeId = enclosingCfgNode(node, graph, sourceFile);
    if (!cfgNodeId) return;
    const span = getSourceSpan(node, sourceFile, relativeFile);
    const key = `${cfgNodeId}:${locationKey(resolved.rootSymbolId, resolved.segments)}:${span?.startOffset ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    accesses.push({
      id: `heap-read:${accesses.length}`, kind: 'read', symbolId: resolved.rootSymbolId,
      rootName: resolved.rootName, path: resolved.segments, locationKey: locationKey(resolved.rootSymbolId, resolved.segments),
      expression: pathNode.getText?.(sourceFile) ?? null, nodeId: cfgNodeId, sourceSpan: span,
      certainty: 'observed-read', aliasRelation: resolved.aliasRelation,
    });
    if (resolved.possibleTarget) {
      const candidate = resolved.possibleTarget;
      accesses.push({
        id: `heap-read:${accesses.length}`, kind: 'read', symbolId: candidate.rootSymbolId,
        rootName: candidate.rootName, path: candidate.segments, locationKey: locationKey(candidate.rootSymbolId, candidate.segments),
        expression: pathNode.getText?.(sourceFile) ?? null, nodeId: cfgNodeId, sourceSpan: span,
        certainty: 'possible-alias-read', aliasRelation: 'may-alias',
      });
    }
  };

  const visit = node => {
    if (!node) return;
    if (node !== functionNode && isNestedFunction(node, functionNode, ts)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = node.parent;
      const isNestedPrefix = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      if (!isNestedPrefix) {
        const isMethodCallee = ts.isCallExpression(parent) && parent.expression === node && ts.isPropertyAccessExpression(node);
        const readNode = isMethodCallee ? node.expression : node;
        const assignmentParent = parent && ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const incrementParent = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === node && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator);
        const deleteParent = ts.isDeleteExpression(parent) && parent.expression === node;
        const compoundRead = assignmentParent && parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken;
        if (!deleteParent && (!assignmentParent || compoundRead) && !incrementParent) add(node, readNode, readNode);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);
  return accesses;
}

function collectDynamicWrites(functionNode, ts, checker, sourceFile, graph, aliasFacts, relativeFile) {
  const writes = [];
  const visit = node => {
    if (!node) return;
    if (node !== functionNode && isNestedFunction(node, functionNode, ts)) return;
    let target = null;
    let expression = null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isElementAccessExpression(node.left)) {
      target = node.left; expression = node;
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) && ts.isElementAccessExpression(node.operand)) {
      target = node.operand; expression = node;
    }
    if (target && !readStaticPath(target, ts)) {
      const root = rootIdentifier(target, ts);
      const info = root && getIdentifierSymbol(root, ts, checker);
      const basePath = readStaticPath(target.expression, ts);
      const cfgNodeId = enclosingCfgNode(expression, graph, sourceFile);
      if (info && basePath && cfgNodeId) {
        const resolved = resolveLocation(info, { ...basePath, segments: [...basePath.segments, '*'] }, aliasAt(aliasFacts, info.symbolId, expression.getStart?.(sourceFile) ?? Number.MAX_SAFE_INTEGER));
        writes.push({
          mutationId: `dynamic-write:${expression.getStart(sourceFile)}`, symbolId: info.symbolId,
          rootSymbolId: resolved.rootSymbolId, rootName: resolved.rootName, path: resolved.segments,
          expression: expression.getText(sourceFile), kind: 'dynamic-index-write', certainty: 'possible',
          sourceSpan: getSourceSpan(expression, sourceFile, relativeFile), nodeId: cfgNodeId,
          possibleTarget: resolved.possibleTarget, aliasRelation: resolved.aliasRelation,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);
  return writes;
}

function normalizeMutation(mutation, aliasFacts, graph, sourceFile) {
  const alias = aliasAt(aliasFacts, mutation.symbolId, mutation.sourceSpan?.startOffset ?? Number.MAX_SAFE_INTEGER);
  const mustAlias = alias?.relation === 'must-alias' && alias?.immutable === true && alias?.targetRootSymbolId;
  const mutationPath = Array.isArray(mutation.path) ? mutation.path : [];
  const rootSymbolId = mustAlias ? alias.targetRootSymbolId : mutation.symbolId;
  const rootName = mustAlias ? (alias.targetPath?.[0] ?? mutation.rootName) : (mutation.rootName ?? mutationPath[0]);
  const path = mustAlias
    ? mutationPath.slice(1)
    : alias?.targetPath?.length && mutationPath[0] === alias.targetPath[0]
      ? mutationPath.slice(alias.targetPath.length)
      : mutationPath.slice(1);
  const nodeId = mutation.nodeId ?? (() => {
    const offset = mutation.sourceSpan?.startOffset;
    if (!Number.isInteger(offset)) return null;
    const containing = graph.nodes.filter(item => item.sourceSpan && item.sourceSpan.startOffset <= offset && item.sourceSpan.endOffset >= (mutation.sourceSpan?.endOffset ?? offset))
      .sort((a, b) => (a.sourceSpan.endOffset - a.sourceSpan.startOffset) - (b.sourceSpan.endOffset - b.sourceSpan.startOffset));
    return containing[0]?.id ?? graph.nodes.find(item => item.sourceSpan?.startOffset === offset)?.id ?? null;
  })();
  const possibleTarget = !mustAlias && alias?.relation === 'may-alias' && alias?.targetRootSymbolId ? {
    rootSymbolId: alias.targetRootSymbolId, rootName: alias.targetPath?.[0] ?? rootName,
    path: [...(alias.targetPath?.slice(1) ?? []), ...path],
  } : null;
  return { ...mutation, rootSymbolId, rootName, path, nodeId, possibleTarget, aliasRelation: alias?.relation ?? null };
}

/**
 * Field-sensitive heap/memory SSA. Each observed access path is a memory
 * location; writes to overlapping paths create conservative memory versions.
 */
export function buildHeapMemorySsa(functionNode, ts, checker, sourceFile, graph, cfgAnalysis, mutations, aliasFacts = [], options = {}) {
  const relativeFile = options.relativeFile ?? sourceFile?.fileName;
  const collectedReads = collectReads(functionNode, ts, checker, sourceFile, graph, aliasFacts, relativeFile);
  const reads = collectedReads.flatMap(item => canonicalizePointsToAccess(item, options.pointsToAnalysis));
  const dynamicWrites = collectDynamicWrites(functionNode, ts, checker, sourceFile, graph, aliasFacts, relativeFile);
  const normalizedMutations = (mutations ?? [])
    .filter(item => item.kind !== 'returned-reference')
    .map(item => normalizeMutation(item, aliasFacts, graph, sourceFile));
  const possibleAliasWrites = [...normalizedMutations, ...dynamicWrites].filter(item => item.possibleTarget).map(item => ({
    ...item, mutationId: `${item.mutationId}:possible-alias-target`, rootSymbolId: item.possibleTarget.rootSymbolId,
    rootName: item.possibleTarget.rootName, path: item.possibleTarget.path, certainty: 'possible',
    kind: 'possible-alias-effect', aliasRelation: 'may-alias',
  }));
  const pointsToAnalysis = options.pointsToAnalysis ?? null;
  const pointsToWrites = [];
  // Alias analysis and points-to can prove the same may-target. Keep one
  // weak memory effect per (source mutation, target root) pair.
  const existingAliasEffectKeys = new Set(possibleAliasWrites.map(item =>
    `${item.mutationId.replace(/:possible-alias-target$/, '')}::${item.rootSymbolId}`));
  if (pointsToAnalysis?.aliasPairs?.length) {
    const symbolNames = pointsToAnalysis.symbols ?? {};
    const sourceWrites = [...normalizedMutations, ...dynamicWrites];
    for (const write of sourceWrites) {
      for (const pair of pointsToAnalysis.aliasPairs) {
        const targetSymbolId = pair.leftSymbolId === write.rootSymbolId ? pair.rightSymbolId
          : pair.rightSymbolId === write.rootSymbolId ? pair.leftSymbolId : null;
        if (!targetSymbolId || targetSymbolId === write.rootSymbolId) continue;
        const effectKey = `${write.mutationId}::${targetSymbolId}`;
        if (existingAliasEffectKeys.has(effectKey)) continue;
        const mustAlias = pair.relation === 'must-alias';
        pointsToWrites.push({
          ...write,
          mutationId: `${write.mutationId}:points-to:${targetSymbolId}`,
          rootSymbolId: targetSymbolId,
          rootName: symbolNames[targetSymbolId] ?? targetSymbolId,
          certainty: mustAlias ? write.certainty : 'possible',
          kind: mustAlias ? 'points-to-must-alias-effect' : 'points-to-may-alias-effect',
          aliasRelation: pair.relation,
          pointsToEvidence: { sharedAllocationSites: [...pair.sharedAllocationSites], confidence: pair.confidence },
        });
      }
    }
  }
  const sourceWrites = [...normalizedMutations, ...possibleAliasWrites, ...dynamicWrites, ...pointsToWrites]
    .filter(item => item.nodeId && item.rootSymbolId);
  const writes = sourceWrites.flatMap(item => canonicalizePointsToAccess(item, pointsToAnalysis));

  const locations = new Map();
  const ensureLocation = (rootSymbolId, rootName, path) => {
    const key = locationKey(rootSymbolId, path);
    if (!locations.has(key)) locations.set(key, { key, symbolId: key, name: `${rootName}.${path.join('.')}`, rootSymbolId, rootName, path });
    return locations.get(key);
  };
  for (const access of reads) ensureLocation(access.symbolId, access.rootName, access.path);
  for (const write of writes) ensureLocation(write.rootSymbolId, write.rootName, write.path);

  const definitions = [];
  const nodeFactMap = new Map(graph.nodes.map(node => [node.id, { nodeId: node.id, definitions: [], uses: [] }]));
  const accesses = [];
  const diagnostics = [];
  for (const location of locations.values()) {
    definitions.push({
      id: `heap-initial:${location.key}`, symbolId: location.key, name: location.name,
      kind: 'initial-memory-state', nodeId: graph.entry, expressionText: null,
      sourceSpan: null, memoryLocation: location.key,
    });
  }

  for (const read of reads) {
    const location = locations.get(read.locationKey);
    nodeFactMap.get(read.nodeId)?.uses.push({ symbolId: location.key, name: location.name, accessId: read.id });
    accesses.push({ ...read, location: location.key, certainty: read.certainty ?? 'observed-read' });
  }

  const writesByLocation = new Map();
  for (const location of locations.values()) {
    const matchingWrites = writes.filter(write => write.rootSymbolId === location.rootSymbolId && pathsOverlap(write.path, location.path));
    for (const write of matchingWrites) {
      const mode = write.certainty === 'definite' && write.path.length === location.path.length && write.path.every((segment, index) => segment === location.path[index])
        ? 'strong' : 'weak';
      const item = {
        id: `heap-def:${location.key}:${write.mutationId}`, symbolId: location.key,
        name: location.name, kind: mode === 'strong' ? 'heap-write' : 'heap-may-write',
        nodeId: write.nodeId, expressionText: write.expression ?? null,
        sourceSpan: write.sourceSpan ?? null, memoryLocation: location.key,
        mutationId: write.mutationId, updateMode: mode, certainty: write.certainty ?? 'possible',
        effectKind: write.kind,
      };
      definitions.push(item);
      const fact = nodeFactMap.get(write.nodeId);
      if (fact) {
        fact.definitions.push(item);
        if (mode === 'weak') fact.uses.push({ symbolId: location.key, name: location.name, accessId: `${write.mutationId}:prior-state` });
      } else diagnostics.push({ code: 'HEAP_WRITE_WITHOUT_CFG_NODE', severity: 'warning', mutationId: write.mutationId, message: 'Heap mutation could not be mapped to a reachable CFG node.' });
      const list = writesByLocation.get(location.key) ?? [];
      list.push(item); writesByLocation.set(location.key, list);
      accesses.push({
        id: write.mutationId, kind: 'write', symbolId: location.rootSymbolId, rootName: location.rootName,
        path: write.path, location: location.key, nodeId: write.nodeId, sourceSpan: write.sourceSpan ?? null,
        certainty: write.certainty ?? 'possible', updateMode: mode, effectKind: write.kind,
      });
    }
  }

  const reachable = new Set(cfgAnalysis.reachableNodeIds ?? []);
  const syntheticFacts = {
    definitions: definitions.filter(item => reachable.has(item.nodeId)),
    nodeFacts: [...nodeFactMap.values()].filter(item => reachable.has(item.nodeId)).map(item => ({
      ...item,
      definitions: item.definitions.filter(definition => reachable.has(definition.nodeId)),
    })),
    // All locations are live at every observed read; using all locations here
    // deliberately keeps memory phis conservative in the presence of aliasing.
    liveIn: Object.fromEntries(graph.nodes.filter(node => reachable.has(node.id)).map(node => [node.id, [...locations.keys()]])),
    useBindings: [],
  };
  const versioned = buildCytronSsa(graph, cfgAnalysis, syntheticFacts, { name: 'heap' });
  const locationSummaries = [...locations.values()].map(location => ({
    id: location.key, rootSymbolId: location.rootSymbolId, rootName: location.rootName,
    path: location.path, definitionCount: (writesByLocation.get(location.key) ?? []).length,
    readCount: reads.filter(item => item.locationKey === location.key).length,
  }));

  for (const write of writes) {
    if (!write.nodeId || !reachable.has(write.nodeId)) diagnostics.push({
      code: 'HEAP_WRITE_UNMAPPED_OR_UNREACHABLE', severity: 'info', mutationId: write.mutationId,
      message: 'Heap effect was retained as a diagnostic but not used to create a memory SSA definition.',
    });
  }
  return Object.freeze({
    schemaVersion: '1.0', algorithm: 'field-sensitive-overlap-aware-cytron-memory-ssa',
    locations: Object.freeze(locationSummaries), accesses: Object.freeze(accesses),
    definitions: versioned.definitions, phiNodes: versioned.phiNodes, useBindings: versioned.useBindings,
    diagnostics: Object.freeze([...diagnostics, ...versioned.diagnostics]),
    convergence: versioned.convergence,
    pointsTo: pointsToAnalysis ? Object.freeze({ aliasPairs: pointsToAnalysis.aliasPairs.length, propagatedWrites: pointsToWrites.length, allocationSiteAccesses: reads.filter(item => item.pointerResolution === 'allocation-site').length + writes.filter(item => item.pointerResolution === 'allocation-site').length, algorithm: pointsToAnalysis.algorithm }) : null,
    limits: Object.freeze({
      pathSensitivity: 'static-field-paths-only',
      aliasing: 'intraprocedural-alias-facts plus bounded points-to; may-alias effects use weak updates',
      overlappingPaths: 'ancestor-descendant writes invalidate observed overlapping paths',
      dynamicIndexes: 'wildcard weak updates',
      unknownCalls: 'possible effects only where mutation analysis emits an effect',
      objectShape: 'field-sensitive locations; aggregate object identity is not fully versioned',
    }),
  });
}
