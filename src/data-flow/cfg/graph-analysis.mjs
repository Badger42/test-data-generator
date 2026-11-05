function asAdjacency(nodes, edges, reverse = false) {
  const map = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    const from = reverse ? edge.to : edge.from;
    const to = reverse ? edge.from : edge.to;
    if (map.has(from) && map.has(to)) map.get(from).push(to);
  }
  for (const values of map.values()) values.sort();
  return map;
}

function traverse(start, adjacency) {
  const seen = new Set();
  const stack = start ? [start] : [];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

function intersectSets(sets) {
  if (!sets.length) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first].filter(value => rest.every(set => set.has(value))));
}

function solveDominators(order, entry, predecessors) {
  const all = new Set(order);
  const dom = new Map(order.map(id => [id, id === entry ? new Set([entry]) : new Set(all)]));
  let changed = true;
  let passes = 0;
  while (changed && passes++ <= order.length * 2 + 1) {
    changed = false;
    for (const id of order) {
      if (id === entry) continue;
      const preds = (predecessors.get(id) ?? []).filter(item => dom.has(item));
      const next = new Set([id, ...intersectSets(preds.map(item => dom.get(item)))]);
      const previous = dom.get(id);
      if (next.size !== previous.size || [...next].some(item => !previous.has(item))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return { sets: dom, passes, converged: !changed };
}

function immediateRelations(order, sets, root) {
  const result = new Map();
  for (const id of order) {
    if (id === root) { result.set(id, null); continue; }
    const strict = [...(sets.get(id) ?? [])].filter(candidate => candidate !== id);
    const parent = strict.sort((a, b) => (sets.get(b)?.size ?? 0) - (sets.get(a)?.size ?? 0) || a.localeCompare(b))[0] ?? null;
    result.set(id, parent);
  }
  return result;
}

function buildFrontiers(order, predecessors, immediateDominator) {
  const frontier = new Map(order.map(id => [id, new Set()]));
  for (const block of order) {
    const preds = predecessors.get(block) ?? [];
    if (preds.length < 2) continue;
    const stop = immediateDominator.get(block);
    for (const predecessor of preds) {
      let runner = predecessor;
      const visited = new Set();
      while (runner && runner !== stop && !visited.has(runner)) {
        visited.add(runner);
        frontier.get(runner)?.add(block);
        runner = immediateDominator.get(runner);
      }
    }
  }
  return frontier;
}

function buildNaturalLoops(nodes, edges, dominators, predecessors) {
  const loops = [];
  const successors = asAdjacency(nodes, edges);
  for (const edge of edges) {
    if (!(dominators.get(edge.from)?.has(edge.to))) continue;
    const header = edge.to;
    const latch = edge.from;
    const members = new Set([header, latch]);
    const stack = latch === header ? [] : [latch];
    while (stack.length) {
      const current = stack.pop();
      for (const predecessor of predecessors.get(current) ?? []) {
        if (!members.has(predecessor)) {
          members.add(predecessor);
          if (predecessor !== header) stack.push(predecessor);
        }
      }
    }
    // Include dominated side paths such as `break` branches that do not reach
    // the back-edge latch. For short-circuit condition CFGs, the loop exit is
    // reached from an expression-condition leaf rather than directly from the
    // structural header, so identify the exit by the owning loop source span.
    const headerNode = nodes.find(node => node.id === header);
    const loopSourceStart = headerNode?.loopStatementStart ?? headerNode?.sourceSpan?.startOffset;
    const headerExitTargets = new Set(nodes
      .filter(node => node.kind.endsWith('-exit') && node.sourceSpan?.startOffset === loopSourceStart)
      .map(node => node.id));
    const pending = [header];
    const visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of successors.get(current) ?? []) {
        if (headerExitTargets.has(next) || !(dominators.get(next)?.has(header))) continue;
        members.add(next);
        if (!visited.has(next)) pending.push(next);
      }
    }
    loops.push({
      id: `loop:${header}:${latch}`,
      header,
      latch,
      nodes: [...members].sort(),
      backEdgeKind: edge.kind,
    });
  }
  return loops.sort((a, b) => a.header.localeCompare(b.header) || a.latch.localeCompare(b.latch));
}

/**
 * Computes classic graph properties over the statement/boolean-expression CFG. It operates
 * only on JSON-safe IDs and deliberately keeps unreachable/non-terminating
 * regions visible instead of silently treating them as ordinary flow.
 */
export function analyzeControlFlowGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.entry || !graph.exit) {
    throw new TypeError('Control-flow graph with nodes, edges, entry and exit is required.');
  }
  const nodeIds = graph.nodes.map(node => node.id);
  const successors = asAdjacency(graph.nodes, graph.edges);
  const predecessors = asAdjacency(graph.nodes, graph.edges, true);
  const reachable = traverse(graph.entry, successors);
  const reverseReachable = traverse(graph.exit, asAdjacency(graph.nodes, graph.edges, true));
  const reachableOrder = nodeIds.filter(id => reachable.has(id));
  const { sets: dominators, passes: dominatorPasses, converged: dominatorsConverged } = solveDominators(reachableOrder, graph.entry, predecessors);
  const immediateDominator = immediateRelations(reachableOrder, dominators, graph.entry);
  const dominanceFrontiers = buildFrontiers(reachableOrder, predecessors, immediateDominator);

  // Post-dominators are computed only for nodes that can reach the exit. Other
  // nodes are reported separately; assigning them an arbitrary post-dominator
  // would overstate control-dependence evidence.
  const postOrder = nodeIds.filter(id => reachable.has(id) && reverseReachable.has(id));
  const reverseSuccessors = new Map(postOrder.map(id => [id, (successors.get(id) ?? []).filter(next => reverseReachable.has(next))]));
  const allPost = new Set(postOrder);
  const postDominators = new Map(postOrder.map(id => [id, id === graph.exit ? new Set([graph.exit]) : new Set(allPost)]));
  let postChanged = true;
  let postDominatorPasses = 0;
  while (postChanged && postDominatorPasses++ <= postOrder.length * 2 + 1) {
    postChanged = false;
    for (const id of [...postOrder].reverse()) {
      if (id === graph.exit) continue;
      const nextNodes = reverseSuccessors.get(id) ?? [];
      const next = new Set([id, ...intersectSets(nextNodes.map(item => postDominators.get(item)).filter(Boolean))]);
      const current = postDominators.get(id);
      if (next.size !== current.size || [...next].some(item => !current.has(item))) {
        postDominators.set(id, next);
        postChanged = true;
      }
    }
  }
  const immediatePostDominator = immediateRelations(postOrder, postDominators, graph.exit);

  const controlDependence = new Map(nodeIds.map(id => [id, new Set()]));
  for (const edge of graph.edges) {
    if (!reachable.has(edge.from) || !reachable.has(edge.to)) continue;
    const postSet = postDominators.get(edge.from);
    if (!postSet || postSet.has(edge.to)) continue;
    const stop = immediatePostDominator.get(edge.from);
    let runner = edge.to;
    const seen = new Set();
    while (runner && runner !== stop && !seen.has(runner)) {
      seen.add(runner);
      controlDependence.get(runner)?.add(edge.from);
      runner = immediatePostDominator.get(runner);
    }
  }

  const naturalLoops = buildNaturalLoops(graph.nodes, graph.edges, dominators, predecessors);
  const encodeSets = map => Object.fromEntries([...map.entries()].map(([id, set]) => [id, [...set].sort()]));
  const encodeMap = map => Object.fromEntries([...map.entries()].map(([id, value]) => [id, value]));

  return Object.freeze({
    schemaVersion: '1.0',
    graphFunctionId: graph.functionId ?? null,
    reachableNodeIds: [...reachable].sort(),
    unreachableNodeIds: nodeIds.filter(id => !reachable.has(id)).sort(),
    nonTerminatingNodeIds: nodeIds.filter(id => reachable.has(id) && !reverseReachable.has(id)).sort(),
    predecessors: encodeMap(predecessors),
    successors: encodeMap(successors),
    dominators: encodeSets(dominators),
    immediateDominator: encodeMap(immediateDominator),
    dominanceFrontiers: encodeSets(dominanceFrontiers),
    postDominators: encodeSets(postDominators),
    immediatePostDominator: encodeMap(immediatePostDominator),
    controlDependence: encodeSets(controlDependence),
    naturalLoops,
    convergence: Object.freeze({
      dominators: dominatorsConverged,
      dominatorPasses,
      postDominators: !postChanged,
      postDominatorPasses,
    }),
    diagnostics: Object.freeze([
      ...(nodeIds.some(id => !reachable.has(id)) ? [{ code: 'UNREACHABLE_CFG_NODES', severity: 'info', nodeIds: nodeIds.filter(id => !reachable.has(id)) }] : []),
      ...(nodeIds.some(id => reachable.has(id) && !reverseReachable.has(id)) ? [{ code: 'NON_TERMINATING_CFG_REGION', severity: 'warning', nodeIds: nodeIds.filter(id => reachable.has(id) && !reverseReachable.has(id)), message: 'Some reachable nodes cannot reach the synthetic function exit; post-dominance/control-dependence facts are omitted for these nodes.' }] : []),
      ...(!dominatorsConverged || postChanged ? [{ code: 'CFG_FIXED_POINT_LIMIT', severity: 'warning', message: 'A graph fixed-point analysis reached its iteration guard.' }] : []),
    ]),
    limits: Object.freeze({
      graphGranularity: graph.granularity ?? 'statement-and-boolean-expression',
      exceptionEdges: 'conservative',
      expressionLevelBranches: true,
      expandedBooleanOperators: ['&&', '||', '!', '?:'],
      postDominanceForNonTerminatingRegions: false,
    }),
  });
}
