import { getIdentifierSymbol, getSourceSpan, isNestedFunction } from '../ast-utils.mjs';

function isAssignment(kind, ts) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function uniqueBy(values, key) {
  const result = new Map();
  for (const value of values) result.set(key(value), value);
  return [...result.values()];
}

function collectNodeFacts(node, cfgNode, ts, checker, sourceFile, relativeFile) {
  const definitions = [];
  const uses = [];
  const addUse = identifier => {
    const info = getIdentifierSymbol(identifier, ts, checker);
    if (info) uses.push({ symbolId: info.symbolId, name: info.name, sourceSpan: getSourceSpan(identifier, sourceFile, relativeFile) });
  };
  const addDefinition = (identifier, expression, kind) => {
    const info = getIdentifierSymbol(identifier, ts, checker);
    if (!info) return;
    let valueExpression = expression;
    if (expression && ts.isBinaryExpression(expression) && isAssignment(expression.operatorToken.kind, ts)) valueExpression = expression.right;
    definitions.push({
      symbolId: info.symbolId,
      name: info.name,
      kind,
      expressionText: valueExpression?.getText?.(sourceFile) ?? null,
      sourceSpan: getSourceSpan(valueExpression ?? identifier, sourceFile, relativeFile),
    });
  };
  const walkReads = current => {
    if (!current) return;
    if (current !== node && isNestedFunction(current, node, ts)) return;
    if (ts.isTypeNode?.(current)) return;
    if (ts.isBinaryExpression(current) && isAssignment(current.operatorToken.kind, ts)) {
      if (current.operatorToken.kind !== ts.SyntaxKind.EqualsToken && ts.isIdentifier(current.left)) addUse(current.left);
      else if (!ts.isIdentifier(current.left)) walkReads(current.left);
      walkReads(current.right);
      return;
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator)) {
      if (ts.isIdentifier(current.operand)) addUse(current.operand);
      else walkReads(current.operand);
      return;
    }
    if (ts.isIdentifier(current)) {
      if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) return;
      if (ts.isPropertyAssignment(current.parent) && current.parent.name === current) return;
      if (ts.isMethodDeclaration(current.parent) && current.parent.name === current) return;
      if (ts.isFunctionDeclaration(current.parent) && current.parent.name === current) return;
      if (ts.isVariableDeclaration(current.parent) && current.parent.name === current) return;
      if (ts.isParameter(current.parent) && current.parent.name === current) return;
      if (ts.isBindingElement(current.parent) && current.parent.name === current) return;
      addUse(current);
      return;
    }
    ts.forEachChild(current, walkReads);
  };
  const visit = current => {
    if (!current) return;
    if (current !== node && isNestedFunction(current, node, ts)) return;
    if (ts.isVariableDeclaration(current)) {
      if (ts.isIdentifier(current.name)) addDefinition(current.name, current.initializer, 'declaration');
      if (current.initializer) walkReads(current.initializer);
      return;
    }
    if (ts.isBinaryExpression(current) && isAssignment(current.operatorToken.kind, ts)) {
      if (ts.isIdentifier(current.left)) {
        if (current.operatorToken.kind !== ts.SyntaxKind.EqualsToken) addUse(current.left);
        addDefinition(current.left, current, current.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'assignment' : 'compound-assignment');
      } else {
        walkReads(current.left);
      }
      walkReads(current.right);
      return;
    }
    if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(current.operator)) {
      if (ts.isIdentifier(current.operand)) {
        addUse(current.operand);
        addDefinition(current.operand, current, 'increment');
      } else walkReads(current.operand);
      return;
    }
    if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(node);
  // The definition visitor is operation-oriented; a separate read pass covers
  // ordinary expressions, calls, returns and short-circuit condition leaves.
  // Assignment LHS identifiers are excluded unless the operator reads old value.
  walkReads(node);
  const mergedUses = new Map();
  for (const item of uses) {
    const current = mergedUses.get(item.symbolId) ?? { symbolId: item.symbolId, name: item.name, occurrences: [] };
    if (item.sourceSpan) current.occurrences.push(item.sourceSpan);
    mergedUses.set(item.symbolId, current);
  }
  return {
    nodeId: cfgNode.id,
    definitions: uniqueBy(definitions, item => `${item.symbolId}:${item.kind}:${item.sourceSpan?.startOffset ?? ''}`),
    uses: [...mergedUses.values()].map(item => ({ ...item, occurrences: item.occurrences.sort((a, b) => a.startOffset - b.startOffset) })),
  };
}

function operationForCfgNode(cfgNode, statement, ts) {
  if (!statement) return null;
  switch (cfgNode.kind) {
    case 'expression-condition': return statement;
    // Structural decision headers are markers only; the expression-condition
    // leaves below them own actual evaluation reads/writes.
    case 'if-condition': return null;
    case 'switch-selector': return statement.expression;
    case 'while-header':
    case 'do-header':
    case 'for-header': return null;
    case 'for-initializer': return statement;
    case 'for-incrementor': return statement;
    case 'for-each-binding': return statement;
    case 'declaration': return statement;
    case 'expression': return statement.expression;
    case 'return':
    case 'throw': return statement.expression ?? null;
    default: return null;
  }
}

function mapCfgOperations(graph, functionNode, ts, checker, sourceFile, relativeFile) {
  const byStart = new Map();
  const visit = node => {
    if (!node) return;
    const start = node.getStart?.(sourceFile);
    if (Number.isInteger(start)) {
      const list = byStart.get(start) ?? [];
      list.push(node);
      byStart.set(start, list);
    }
    if (node !== functionNode && isNestedFunction(node, functionNode, ts)) return;
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body);
  const facts = new Map();
  for (const cfgNode of graph.nodes) {
    if (!cfgNode.sourceSpan) continue;
    const candidates = byStart.get(cfgNode.sourceSpan.startOffset) ?? [];
    if (!candidates.length) continue;
    const statement = candidates.find(node => ts.isStatement(node) || ts.isVariableDeclarationList(node) || ts.isExpression(node)) ?? candidates[0];
    const operation = operationForCfgNode(cfgNode, statement, ts);
    if (!operation) continue;
    facts.set(cfgNode.id, collectNodeFacts(operation, cfgNode, ts, checker, sourceFile, relativeFile));
  }
  return facts;
}

function setUnion(target, values) {
  let changed = false;
  for (const value of values) if (!target.has(value)) { target.add(value); changed = true; }
  return changed;
}

function encodeByNode(map, ids) {
  return Object.fromEntries(ids.map(id => [id, [...(map.get(id) ?? [])].sort()]));
}

/**
 * Reaching-definitions and liveness fixed points over the CFG, plus Cytron-style
 * iterated dominance-frontier phi placement. Definitions are statement-level;
 * multiple same-symbol writes in one statement are represented conservatively.
 */
export function analyzeReachingDefinitions(graph, cfgAnalysis, functionNode, ts, checker, sourceFile, options = {}) {
  if (!graph || !cfgAnalysis) throw new TypeError('CFG and CFG analysis are required.');
  const reachable = new Set(cfgAnalysis.reachableNodeIds);
  const nodeIds = graph.nodes.map(node => node.id).filter(id => reachable.has(id));
  const nodeFacts = mapCfgOperations(graph, functionNode, ts, checker, sourceFile, options.relativeFile ?? sourceFile.fileName);
  const definitions = [];
  const gen = new Map(nodeIds.map(id => [id, new Set()]));
  const defsBySymbol = new Map();
  const use = new Map(nodeIds.map(id => [id, new Set()]));
  const defSymbols = new Map(nodeIds.map(id => [id, new Set()]));
  const diagnostics = [];

  const addDef = (nodeId, item, kindOverride = null) => {
    const id = `def:${nodeId}:${item.symbolId}:${definitions.length}`;
    const definition = { id, symbolId: item.symbolId, name: item.name, kind: kindOverride ?? item.kind, nodeId,
      expressionText: item.expressionText ?? null, sourceSpan: item.sourceSpan ?? null };
    definitions.push(definition);
    const values = defsBySymbol.get(item.symbolId) ?? [];
    values.push(definition);
    defsBySymbol.set(item.symbolId, values);
    gen.get(nodeId)?.add(id);
    defSymbols.get(nodeId)?.add(item.symbolId);
  };

  for (const parameter of functionNode?.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue;
    const info = getIdentifierSymbol(parameter.name, ts, checker);
    if (info) addDef(graph.entry, { ...info, kind: 'parameter', expressionText: null, sourceSpan: getSourceSpan(parameter, sourceFile, options.relativeFile) }, 'parameter');
  }
  for (const id of nodeIds) {
    const fact = nodeFacts.get(id);
    if (!fact) continue;
    for (const item of fact.uses) use.get(id).add(item.symbolId);
    const grouped = new Map();
    for (const item of fact.definitions) {
      const items = grouped.get(item.symbolId) ?? [];
      items.push(item);
      grouped.set(item.symbolId, items);
    }
    for (const items of grouped.values()) {
      if (items.length > 1) diagnostics.push({ code: 'MULTIPLE_DEFINITIONS_IN_CFG_NODE', severity: 'warning', nodeId: id, symbolId: items[0].symbolId, message: 'Multiple writes to the same symbol occur in one CFG node; intra-node definition order is summarized conservatively.' });
      for (const item of items) addDef(id, item);
    }
  }

  // A CFG node can have multiple writes to a symbol. Keep the final one as GEN.
  for (const id of nodeIds) {
    const bySymbol = new Map();
    for (const defId of gen.get(id)) {
      const item = definitions.find(definition => definition.id === defId);
      bySymbol.set(item.symbolId, defId);
    }
    gen.set(id, new Set(bySymbol.values()));
  }

  const allDefinitions = new Set(definitions.map(item => item.id));
  const kill = new Map(nodeIds.map(id => [id, new Set()]));
  for (const id of nodeIds) {
    const own = gen.get(id);
    const ownSymbols = new Set([...own].map(defId => definitions.find(item => item.id === defId)?.symbolId));
    for (const definition of definitions) if (ownSymbols.has(definition.symbolId) && !own.has(definition.id)) kill.get(id).add(definition.id);
  }

  const reachingIn = new Map(nodeIds.map(id => [id, new Set()]));
  const reachingOut = new Map(nodeIds.map(id => [id, new Set(gen.get(id))]));
  let reachingChanged = true;
  let reachingPasses = 0;
  while (reachingChanged && reachingPasses++ <= nodeIds.length * (definitions.length + 1) + 1) {
    reachingChanged = false;
    for (const id of nodeIds) {
      const incoming = new Set();
      for (const predecessor of cfgAnalysis.predecessors[id] ?? []) if (reachable.has(predecessor)) setUnion(incoming, reachingOut.get(predecessor) ?? []);
      const outgoing = new Set(gen.get(id));
      for (const definition of incoming) if (!kill.get(id).has(definition)) outgoing.add(definition);
      const oldIn = reachingIn.get(id);
      const oldOut = reachingOut.get(id);
      if (incoming.size !== oldIn.size || [...incoming].some(value => !oldIn.has(value)) || outgoing.size !== oldOut.size || [...outgoing].some(value => !oldOut.has(value))) {
        reachingIn.set(id, incoming); reachingOut.set(id, outgoing); reachingChanged = true;
      }
    }
  }

  const liveIn = new Map(nodeIds.map(id => [id, new Set()]));
  const liveOut = new Map(nodeIds.map(id => [id, new Set()]));
  let liveChanged = true;
  let livenessPasses = 0;
  while (liveChanged && livenessPasses++ <= nodeIds.length * (definitions.length + 1) + 1) {
    liveChanged = false;
    for (const id of [...nodeIds].reverse()) {
      const outgoing = new Set();
      for (const successor of cfgAnalysis.successors[id] ?? []) if (reachable.has(successor)) setUnion(outgoing, liveIn.get(successor) ?? []);
      const incoming = new Set(use.get(id));
      for (const symbolId of outgoing) if (!defSymbols.get(id).has(symbolId)) incoming.add(symbolId);
      const oldIn = liveIn.get(id); const oldOut = liveOut.get(id);
      if (incoming.size !== oldIn.size || [...incoming].some(value => !oldIn.has(value)) || outgoing.size !== oldOut.size || [...outgoing].some(value => !oldOut.has(value))) {
        liveIn.set(id, incoming); liveOut.set(id, outgoing); liveChanged = true;
      }
    }
  }

  const phiCandidates = [];
  const frontier = cfgAnalysis.dominanceFrontiers;
  for (const [symbolId, symbolDefinitions] of defsBySymbol) {
    const definitionSites = new Set(symbolDefinitions.map(item => item.nodeId));
    const work = [...definitionSites];
    const placed = new Set();
    while (work.length) {
      const current = work.shift();
      for (const candidate of frontier[current] ?? []) {
        if (placed.has(candidate)) continue;
        placed.add(candidate);
        const reaching = new Map();
        for (const predecessor of cfgAnalysis.predecessors[candidate] ?? []) {
          const defs = [...(reachingOut.get(predecessor) ?? [])]
            .filter(defId => definitions.find(item => item.id === defId)?.symbolId === symbolId);
          reaching.set(predecessor, defs);
        }
        phiCandidates.push({
          id: `phi-candidate:${candidate}:${symbolId}`,
          symbolId,
          name: symbolDefinitions[0].name,
          nodeId: candidate,
          inputs: [...reaching.entries()].map(([predecessor, values]) => ({ predecessor, reachingDefinitions: values })),
          complete: [...reaching.values()].every(values => values.length === 1),
        });
        if (!definitionSites.has(candidate)) work.push(candidate);
      }
    }
  }

  const phiByNodeSymbol = new Map(phiCandidates.map(item => [`${item.nodeId}:${item.symbolId}`, item]));
  const useBindings = [];
  for (const id of nodeIds) {
    for (const item of nodeFacts.get(id)?.uses ?? []) {
      const localPhi = phiByNodeSymbol.get(`${id}:${item.symbolId}`);
      const reaching = [...(reachingIn.get(id) ?? [])]
        .map(defId => definitions.find(definition => definition.id === defId))
        .filter(definition => definition?.symbolId === item.symbolId);
      const dominating = new Set(cfgAnalysis.dominators[id] ?? []);
      const dominatingPhi = phiCandidates
        .filter(candidate => candidate.symbolId === item.symbolId && dominating.has(candidate.nodeId))
        .sort((a, b) => (cfgAnalysis.dominators[b.nodeId]?.length ?? 0) - (cfgAnalysis.dominators[a.nodeId]?.length ?? 0))[0] ?? null;
      const dominatingDefinition = reaching
        .filter(definition => dominating.has(definition.nodeId))
        .sort((a, b) => (cfgAnalysis.dominators[b.nodeId]?.length ?? 0) - (cfgAnalysis.dominators[a.nodeId]?.length ?? 0))[0] ?? null;
      const selectedPhi = localPhi ?? (dominatingPhi && (!dominatingDefinition ||
        (cfgAnalysis.dominators[dominatingPhi.nodeId]?.length ?? 0) >= (cfgAnalysis.dominators[dominatingDefinition.nodeId]?.length ?? 0)) ? dominatingPhi : null);
      const selectedDefinition = selectedPhi ? null : dominatingDefinition ?? (reaching.length === 1 ? reaching[0] : null);
      useBindings.push({
        nodeId: id,
        symbolId: item.symbolId,
        name: item.name,
        reachingDefinitions: reaching.map(definition => definition.id),
        value: selectedPhi?.id ?? selectedDefinition?.id ?? null,
        resolution: selectedPhi ? 'phi-candidate' : selectedDefinition ? 'reaching-definition' : reaching.length === 0 ? 'unresolved-before-definition' : 'ambiguous-reaching-definitions',
      });
    }
  }
  if (reachingChanged || liveChanged) diagnostics.push({ code: 'DATA_FLOW_FIXED_POINT_LIMIT', severity: 'warning', message: 'A reaching-definitions or liveness analysis reached its iteration guard.' });
  const definitionsById = new Map(definitions.map(item => [item.id, item]));
  const encodeSymbolMap = map => Object.fromEntries([...map.entries()].map(([id, set]) => [id, [...set].sort()]));
  const reachingDetails = Object.fromEntries(nodeIds.map(id => [id, {
    in: [...reachingIn.get(id)].map(defId => definitionsById.get(defId)).filter(Boolean),
    out: [...reachingOut.get(id)].map(defId => definitionsById.get(defId)).filter(Boolean),
  }]));

  return Object.freeze({
    schemaVersion: '1.0',
    algorithm: 'cfg-reaching-definitions-liveness-dominance-frontier-phi-candidates',
    definitions: Object.freeze(definitions),
    nodeFacts: Object.freeze([...nodeFacts.values()].filter(item => reachable.has(item.nodeId))),
    reachingDefinitions: Object.freeze(reachingDetails),
    liveIn: Object.freeze(encodeSymbolMap(liveIn)),
    liveOut: Object.freeze(encodeSymbolMap(liveOut)),
    phiCandidates: Object.freeze(phiCandidates),
    useBindings: Object.freeze(useBindings),
    diagnostics: Object.freeze(diagnostics),
    convergence: Object.freeze({ reachingDefinitions: !reachingChanged, reachingPasses, liveness: !liveChanged, livenessPasses }),
    limits: Object.freeze({ heapMemorySsa: false, expressionLevelDefinitions: false, multipleWritesPerStatement: 'conservative-summary', exceptionalFlow: 'cfg-dependent' }),
  });
}
