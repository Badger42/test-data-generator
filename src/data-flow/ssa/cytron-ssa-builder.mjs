/**
 * Dominator-tree SSA construction with iterated dominance-frontier phi placement.
 * Inputs are JSON-safe CFG/Data Flow facts; TypeScript compiler objects never
 * cross this module boundary.
 */
function unique(values) { return [...new Set(values)]; }

function stableSortByGraphOrder(ids, order) {
  return [...ids].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
}

function buildDominatorChildren(nodeIds, entry, immediateDominator, order) {
  const children = new Map(nodeIds.map(id => [id, []]));
  const orphans = [];
  for (const id of nodeIds) {
    if (id === entry) continue;
    const parent = immediateDominator?.[id];
    if (parent && children.has(parent)) children.get(parent).push(id);
    else orphans.push(id);
  }
  for (const values of children.values()) values.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || a.localeCompare(b));
  return { children, orphans };
}

/** Build a pruned Cytron SSA graph from block-level definitions and uses. */
export function buildCytronSsa(graph, cfgAnalysis, facts, options = {}) {
  if (!graph?.entry || !Array.isArray(graph.nodes) || !cfgAnalysis?.dominanceFrontiers) {
    throw new TypeError('CFG and dominance analysis are required for Cytron SSA construction.');
  }
  const reachable = new Set(cfgAnalysis.reachableNodeIds ?? []);
  const nodeIds = graph.nodes.map(node => node.id).filter(id => reachable.has(id));
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const nodeFacts = new Map((facts.nodeFacts ?? []).map(item => [item.nodeId, item]));
  const rawDefinitions = facts.definitions ?? [];
  const definitionsByNode = new Map(nodeIds.map(id => [id, []]));
  const diagnostics = [];

  for (const definition of rawDefinitions) {
    if (!definitionsByNode.has(definition.nodeId)) continue;
    definitionsByNode.get(definition.nodeId).push(definition);
  }
  for (const [nodeId, definitions] of definitionsByNode) {
    definitions.sort((a, b) => (a.sourceSpan?.startOffset ?? 0) - (b.sourceSpan?.startOffset ?? 0) || a.id.localeCompare(b.id));
    const bySymbol = new Map();
    for (const item of definitions) {
      const group = bySymbol.get(item.symbolId) ?? [];
      group.push(item);
      bySymbol.set(item.symbolId, group);
    }
    for (const [symbolId, items] of bySymbol) {
      if (items.length > 1) {
        diagnostics.push({
          code: 'SSA_MULTIPLE_DEFINITIONS_IN_BLOCK', severity: 'warning', nodeId, symbolId,
          message: 'Multiple writes to one symbol are represented by the final block definition; expression-level ordering is not available in the current CFG granularity.',
        });
      }
    }
  }

  const effectiveDefinitions = [];
  for (const nodeId of nodeIds) {
    const values = definitionsByNode.get(nodeId) ?? [];
    const bySymbol = new Map();
    for (const item of values) bySymbol.set(item.symbolId, item);
    effectiveDefinitions.push(...bySymbol.values());
  }

  const defsBySymbol = new Map();
  for (const definition of effectiveDefinitions) {
    const sites = defsBySymbol.get(definition.symbolId) ?? new Set();
    sites.add(definition.nodeId);
    defsBySymbol.set(definition.symbolId, sites);
  }

  const phiSites = new Map();
  const liveIn = facts.liveIn ?? {};
  const frontier = cfgAnalysis.dominanceFrontiers;
  for (const [symbolId, definitionSites] of defsBySymbol) {
    const work = stableSortByGraphOrder(definitionSites, order);
    const visited = new Set();
    const placed = new Set();
    while (work.length) {
      const current = work.shift();
      for (const candidate of stableSortByGraphOrder(frontier[current] ?? [], order)) {
        if (placed.has(candidate)) continue;
        // Pruned SSA: do not place a phi when the value is dead at the join.
        if (!(liveIn[candidate] ?? []).includes(symbolId)) continue;
        placed.add(candidate);
        if (!definitionSites.has(candidate) && !visited.has(candidate)) {
          visited.add(candidate);
          work.push(candidate);
        }
      }
    }
    if (placed.size) phiSites.set(symbolId, placed);
  }

  const dom = buildDominatorChildren(nodeIds, graph.entry, cfgAnalysis.immediateDominator, order);
  for (const orphan of dom.orphans) {
    diagnostics.push({ code: 'SSA_DOMINATOR_TREE_ORPHAN', severity: 'warning', nodeId: orphan, message: 'Reachable CFG node has no immediate dominator; it is attached to the synthetic entry for conservative renaming.' });
    dom.children.get(graph.entry)?.push(orphan);
  }
  dom.children.get(graph.entry)?.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const symbolNames = new Map();
  for (const item of effectiveDefinitions) symbolNames.set(item.symbolId, item.name);
  for (const item of nodeFacts.values()) for (const use of item.uses ?? []) symbolNames.set(use.symbolId, use.name);

  const stacks = new Map();
  const counters = new Map();
  const top = symbolId => { const stack = stacks.get(symbolId); return stack?.length ? stack[stack.length - 1] : null; };
  const push = (symbolId, value) => {
    const stack = stacks.get(symbolId) ?? [];
    stack.push(value);
    stacks.set(symbolId, stack);
  };
  const pop = (symbolId) => {
    const stack = stacks.get(symbolId);
    if (stack?.length) stack.pop();
  };
  const nextVersion = symbolId => {
    const version = counters.get(symbolId) ?? 0;
    counters.set(symbolId, version + 1);
    return version;
  };

  const phisByNode = new Map(nodeIds.map(id => [id, []]));
  for (const [symbolId, sites] of phiSites) {
    for (const nodeId of sites) {
      const name = symbolNames.get(symbolId) ?? symbolId;
      const version = nextVersion(symbolId);
      const output = `${symbolId}#${version}`;
      const naturalLoopHeader = (cfgAnalysis.naturalLoops ?? []).some(loop => loop.header === nodeId);
      phisByNode.get(nodeId)?.push({
        id: `phi:${output}`, symbolId, name, version, output, nodeId,
        inputs: [], sourceSpan: graph.nodes.find(node => node.id === nodeId)?.sourceSpan ?? null,
        kind: naturalLoopHeader ? 'loop-carried' : 'branch-merge',
      });
    }
  }
  for (const values of phisByNode.values()) values.sort((a, b) => a.symbolId.localeCompare(b.symbolId));

  const versionedDefinitions = [];
  const useBindings = [];
  const phiIncoming = new Map();
  const successors = cfgAnalysis.successors ?? {};
  const predecessors = cfgAnalysis.predecessors ?? {};
  const visited = new Set();

  const rename = nodeId => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const pushed = [];

    for (const phi of phisByNode.get(nodeId) ?? []) {
      push(phi.symbolId, phi.output);
      pushed.push(phi.symbolId);
    }

    const blockUses = nodeFacts.get(nodeId)?.uses ?? [];
    const usedValues = new Map();
    for (const item of blockUses) {
      const value = top(item.symbolId);
      usedValues.set(item.symbolId, value);
      useBindings.push({
        id: `use:${nodeId}:${item.symbolId}`, nodeId, symbolId: item.symbolId, name: item.name,
        value, resolution: value ? 'ssa-version' : 'unresolved-before-definition',
        reachingDefinitionFacts: (facts.useBindings ?? []).find(binding => binding.nodeId === nodeId && binding.symbolId === item.symbolId)?.reachingDefinitions ?? [],
        occurrences: (item.occurrences ?? []).map(span => ({ ...span })),
      });
    }

    const bySymbol = new Map();
    for (const definition of definitionsByNode.get(nodeId) ?? []) bySymbol.set(definition.symbolId, definition);
    for (const definition of bySymbol.values()) {
      const version = nextVersion(definition.symbolId);
      const id = `${definition.symbolId}#${version}`;
      versionedDefinitions.push({
        id, symbolId: definition.symbolId, name: definition.name, version,
        kind: definition.kind, nodeId, cfgNodeId: nodeId,
        expressionText: definition.expressionText ?? null,
        sourceSpan: definition.sourceSpan ?? null,
        operands: [...usedValues.entries()].filter(([, value]) => value).map(([symbolId, value]) => ({ symbolId, value })),
        originDefinitionId: definition.id,
      });
      push(definition.symbolId, id);
      pushed.push(definition.symbolId);
    }

    for (const successor of unique(successors[nodeId] ?? [])) {
      for (const phi of phisByNode.get(successor) ?? []) {
        const incoming = phiIncoming.get(phi.id) ?? new Map();
        incoming.set(nodeId, top(phi.symbolId));
        phiIncoming.set(phi.id, incoming);
      }
    }

    for (const child of dom.children.get(nodeId) ?? []) rename(child);
    for (let index = pushed.length - 1; index >= 0; index--) pop(pushed[index]);
  };
  rename(graph.entry);

  for (const nodeId of nodeIds) {
    if (!visited.has(nodeId)) diagnostics.push({ code: 'SSA_RENAME_NODE_UNVISITED', severity: 'warning', nodeId, message: 'CFG node was not visited during dominator-tree renaming.' });
  }

  const predecessorOrder = nodeId => stableSortByGraphOrder((predecessors[nodeId] ?? []).filter(id => reachable.has(id)), order);
  const phiNodes = [...phisByNode.values()].flat().map(phi => {
    const incoming = phiIncoming.get(phi.id) ?? new Map();
    const inputs = predecessorOrder(phi.nodeId).map(predecessor => ({
      predecessor,
      value: incoming.has(predecessor) ? incoming.get(predecessor) : null,
    }));
    if (inputs.some(item => item.value === null)) {
      diagnostics.push({ code: 'SSA_PHI_INCOMPLETE_INPUT', severity: 'warning', nodeId: phi.nodeId, symbolId: phi.symbolId, message: 'At least one incoming CFG edge has no resolved SSA value.' });
    }
    return { ...phi, inputs, complete: inputs.length > 0 && inputs.every(item => item.value !== null) };
  });

  const incompleteUses = useBindings.filter(item => !item.value);
  if (incompleteUses.length) diagnostics.push({ code: 'SSA_UNRESOLVED_USES', severity: 'warning', message: `${incompleteUses.length} use binding(s) have no reaching SSA version.` });

  return Object.freeze({
    schemaVersion: '1.0', algorithm: 'cytron-iterated-dominance-frontier-dominator-tree-renaming',
    definitions: Object.freeze(versionedDefinitions),
    phiNodes: Object.freeze(phiNodes),
    useBindings: Object.freeze(useBindings),
    diagnostics: Object.freeze(diagnostics),
    convergence: Object.freeze({ dominatorTreeTraversal: true, allReachableNodesVisited: nodeIds.every(id => visited.has(id)) }),
    limits: Object.freeze({
      granularity: graph.granularity ?? 'statement-and-boolean-expression',
      prunedPhiPlacement: true,
      intraNodeWriteOrdering: 'conservative-final-definition-per-symbol',
      heapMemorySsa: false,
    }),
  });
}
