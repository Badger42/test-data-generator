/** Joins natural-loop, reaching-definition and reduce facts without simulating iterations. */
export function buildLoopFlowSummary(graph, controlFlowAnalysis, flowAnalysis, reduceFlows = []) {
  const nodeById = new Map((graph?.nodes ?? []).map(node => [node.id, node]));
  const loops = (controlFlowAnalysis?.naturalLoops ?? []).map(loop => {
    const members = new Set(loop.nodes);
    const headerNode = nodeById.get(loop.header);
    const carried = (flowAnalysis?.phiCandidates ?? [])
      .filter(candidate => members.has(candidate.nodeId))
      .map(candidate => ({ symbolId: candidate.symbolId, name: candidate.name, mergeNodeId: candidate.nodeId, complete: candidate.complete }));
    const exits = [];
    for (const nodeId of loop.nodes) {
      for (const successor of controlFlowAnalysis?.successors?.[nodeId] ?? []) {
        if (!members.has(successor)) exits.push({ from: nodeId, to: successor });
      }
    }
    const breaks = graph.edges.filter(edge => edge.kind === 'break' && members.has(edge.from));
    const continues = graph.edges.filter(edge => edge.kind === 'continue' && members.has(edge.from));
    const liveOut = [...new Set(exits.flatMap(edge => flowAnalysis?.liveIn?.[edge.to] ?? []))].sort();
    return {
      id: loop.id,
      kind: headerNode?.kind?.replace(/-header$/, '') ?? 'loop',
      header: loop.header,
      latch: loop.latch,
      nodeIds: [...loop.nodes],
      carriedVariables: carried,
      exitEdges: exits,
      breakEdges: breaks.map(edge => ({ from: edge.from, to: edge.to })),
      continueEdges: continues.map(edge => ({ from: edge.from, to: edge.to })),
      liveOut,
      stateTransfer: 'reaching-definitions-and-phi-candidates',
      confidence: carried.every(item => item.complete) ? 'medium' : 'low',
    };
  });
  const reduceLoops = (reduceFlows ?? []).map(item => ({
    id: `reduce-loop:${item.id}`,
    kind: 'array-reduce',
    sourceSpan: item.sourceSpan,
    accumulator: item.accumulator,
    hasAccumulatorRecurrence: item.hasAccumulatorRecurrence,
    stateful: item.stateful,
    effects: item.effects,
    executionModel: item.executionModel,
    concreteSimulation: false,
    confidence: item.confidence,
  }));
  return Object.freeze({
    schemaVersion: '1.0',
    loops: Object.freeze(loops),
    reduceLoops: Object.freeze(reduceLoops),
    limits: Object.freeze({ arbitraryLoopUnrolling: false, pathSensitiveIterationStates: false, breakContinueStateMerge: 'conservative-live-out' }),
  });
}
