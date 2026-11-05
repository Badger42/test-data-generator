import { collectReferencedPaths, getIdentifierSymbol, getSourceSpan, isNestedFunction, unwrapExpression } from '../ast-utils.mjs';

function isAssignmentOperator(kind, ts) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function assignmentTarget(node, ts, checker) {
  const current = unwrapExpression(node, ts);
  let root = current;
  while (root && (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))) root = root.expression;
  if (!root || !ts.isIdentifier(root)) return null;
  const info = getIdentifierSymbol(root, ts, checker);
  return info ? { ...info, path: current.getText?.() ?? root.text, isProperty: current !== root } : null;
}

function cloneEnvironment(environment) { return new Map(environment); }

/**
 * Bounded intraprocedural SSA builder. It models straight-line assignments,
 * if/else joins, switch joins and loop-carried variables. Loop phi nodes are
 * conservative summaries, not a proof of arbitrary iteration semantics.
 */
export function buildSsaGraph(functionNode, ts, checker, sourceFile, options = {}) {
  const definitions = [];
  const phiNodes = [];
  const diagnostics = [];
  const versionCounters = new Map();
  let nextBlock = 0;

  const blockId = label => `${label ?? 'block'}:${++nextBlock}`;
  const findCfgNodeId = (node, preferredKind = null) => {
    const start = node?.getStart?.(sourceFile);
    if (!Number.isInteger(start)) return null;
    const candidates = options.controlFlowGraph?.nodes?.filter(item => item.sourceSpan?.startOffset === start) ?? [];
    if (!candidates.length) return null;
    return (preferredKind && candidates.find(item => item.kind === preferredKind))?.id ?? candidates[0].id;
  };
  const nextVersion = symbolId => {
    const value = (versionCounters.get(symbolId) ?? -1) + 1;
    versionCounters.set(symbolId, value);
    return value;
  };
  const declareVersion = (target, expression, kind, environment, block, extra = {}) => {
    const version = nextVersion(target.symbolId);
    const id = `${target.symbolId}#${version}`;
    const refs = expression ? collectReferencedPaths(expression, ts, checker) : [];
    const dependsOn = refs.map(ref => ref.symbolId ? environment.get(ref.symbolId) : null).filter(Boolean);
    const definition = {
      id, symbolId: target.symbolId, name: target.name, version, kind,
      expressionText: expression?.getText?.(sourceFile) ?? null,
      dependencies: refs.map(ref => ref.text), dependsOnVersions: [...new Set(dependsOn)],
      blockId: block,
      cfgNodeId: findCfgNodeId(expression ?? target.node),
      sourceSpan: getSourceSpan(expression ?? target.node, sourceFile, options.relativeFile),
      ...extra,
    };
    definitions.push(definition);
    environment.set(target.symbolId, id);
    return id;
  };
  const symbolTarget = identifier => {
    const info = getIdentifierSymbol(identifier, ts, checker);
    if (!info) return null;
    return { ...info, node: identifier };
  };
  const mergeEnvironments = (before, branches, node, label) => {
    const merged = cloneEnvironment(before);
    const keys = new Set([...before.keys(), ...branches.flatMap(branch => [...branch.keys()])]);
    for (const symbolId of keys) {
      const inputs = branches.map(branch => branch.get(symbolId) ?? before.get(symbolId) ?? null);
      const unique = [...new Set(inputs.filter(Boolean))];
      const original = before.get(symbolId) ?? null;
      if (unique.length <= 1 || (unique.length === 1 && unique[0] === original)) continue;
      const sourceDefinition = definitions.find(item => item.symbolId === symbolId);
      const name = sourceDefinition?.name ?? symbolId.split(':')[symbolId.split(':').length - 1].split('#')[0];
      const version = nextVersion(symbolId);
      const output = `${symbolId}#${version}`;
      definitions.push({
        id: output, symbolId, name, version, kind: 'phi', expressionText: null,
        dependencies: [], dependsOnVersions: unique, blockId: blockId(label),
        cfgNodeId: findCfgNodeId(node, label === 'if' ? 'if-join' : label === 'loop' ? undefined : null),
        sourceSpan: getSourceSpan(node, sourceFile, options.relativeFile),
      });
      phiNodes.push({
        id: `phi:${output}`, symbolId, name, output,
        inputs: inputs.map((value, index) => ({ value, predecessor: `${label}:${index}` })),
        sourceSpan: getSourceSpan(node, sourceFile, options.relativeFile),
        cfgNodeId: findCfgNodeId(node, label === 'if' ? 'if-join' : undefined),
        kind: label === 'loop' ? 'loop-carried' : 'branch-merge',
      });
      merged.set(symbolId, output);
    }
    return merged;
  };

  const processExpression = (node, environment, block) => {
    if (!node) return;
    if (isNestedFunction(node, functionNode, ts)) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind, ts)) {
      processExpression(node.right, environment, block);
      const target = assignmentTarget(node.left, ts, checker);
      if (target && !target.isProperty) {
        const kind = node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.FirstAssignment ? 'assignment' : 'compound-assignment';
        const versionTarget = { ...target, node: node.left };
        declareVersion(versionTarget, node, kind, environment, block, { targetPath: target.path });
      }
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const target = assignmentTarget(node.operand, ts, checker);
      if (target && !target.isProperty) declareVersion({ ...target, node: node.operand }, node, 'increment', environment, block, { targetPath: target.path });
      return;
    }
    ts.forEachChild(node, child => processExpression(child, environment, block));
  };

  const alwaysTerminates = statement => {
    if (!statement) return false;
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) {
      const last = statement.statements[statement.statements.length - 1];
      return alwaysTerminates(last);
    }
    if (ts.isIfStatement(statement)) return Boolean(statement.elseStatement) &&
      alwaysTerminates(statement.thenStatement) && alwaysTerminates(statement.elseStatement);
    if (ts.isSwitchStatement(statement)) {
      const clauses = statement.caseBlock.clauses;
      return clauses.some(clause => clause.kind === ts.SyntaxKind.DefaultClause) &&
        clauses.every(clause => alwaysTerminates({ kind: ts.SyntaxKind.Block, statements: clause.statements }));
    }
    return false;
  };

  const processStatementList = (statements, initialEnvironment, label = 'block') => {
    let environment = cloneEnvironment(initialEnvironment);
    const block = blockId(label);
    for (const statement of statements ?? []) {
      environment = processStatement(statement, environment, block);
      if (alwaysTerminates(statement)) break;
    }
    return environment;
  };

  const processLoop = (node, environment, block, bodyNode, label, extraExpressions = []) => {
    const before = cloneEnvironment(environment);
    if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const target = symbolTarget(declaration.name);
        if (target) declareVersion({ ...target, node: declaration.name }, declaration.initializer, 'declaration', environment, block);
      }
    } else if (node.initializer) processExpression(node.initializer, environment, block);
    if (node.condition) processExpression(node.condition, environment, block);
    const bodyEnvironment = bodyNode && ts.isBlock(bodyNode)
      ? processStatementList(bodyNode.statements, environment, `${label}-body`)
      : bodyNode ? processStatement(bodyNode, cloneEnvironment(environment), blockId(`${label}-body`)) : cloneEnvironment(environment);
    for (const expression of extraExpressions) processExpression(expression, bodyEnvironment, block);
    const merged = mergeEnvironments(before, [environment, bodyEnvironment], node, 'loop');
    for (const [symbolId, version] of environment) merged.set(symbolId, merged.get(symbolId) ?? version);
    return merged;
  };

  const processStatement = (statement, environment, block) => {
    if (!statement) return environment;
    if (ts.isBlock(statement)) return processStatementList(statement.statements, environment, 'block');
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const target = symbolTarget(declaration.name);
        if (target) declareVersion({ ...target, node: declaration.name }, declaration.initializer, 'declaration', environment, block);
      }
      return environment;
    }
    if (ts.isExpressionStatement(statement)) {
      processExpression(statement.expression, environment, block);
      return environment;
    }
    if (ts.isIfStatement(statement)) {
      processExpression(statement.expression, environment, block);
      const before = cloneEnvironment(environment);
      const thenEnvironment = processStatement(statement.thenStatement, cloneEnvironment(before), blockId('if-then'));
      const elseEnvironment = statement.elseStatement
        ? processStatement(statement.elseStatement, cloneEnvironment(before), blockId('if-else'))
        : cloneEnvironment(before);
      const reachable = [];
      if (!alwaysTerminates(statement.thenStatement)) reachable.push(thenEnvironment);
      if (!statement.elseStatement || !alwaysTerminates(statement.elseStatement)) reachable.push(elseEnvironment);
      return reachable.length ? mergeEnvironments(before, reachable, statement, 'if') : before;
    }
    if (ts.isForStatement(statement)) return processLoop(statement, environment, block, statement.statement, 'for', [statement.incrementor]);
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
      const before = cloneEnvironment(environment);
      if (ts.isVariableDeclarationList(statement.initializer)) {
        for (const declaration of statement.initializer.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const target = symbolTarget(declaration.name);
          if (target) declareVersion({ ...target, node: declaration.name }, null, 'declaration', environment, block, { loopBinding: true });
        }
      } else {
        processExpression(statement.initializer, environment, block);
      }
      const body = processStatement(statement.statement, cloneEnvironment(environment), blockId('for-each-body'));
      return mergeEnvironments(before, [environment, body], statement, 'loop');
    }
    if (ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
      const before = cloneEnvironment(environment);
      if (ts.isWhileStatement(statement)) processExpression(statement.expression, environment, block);
      const body = processStatement(statement.statement, cloneEnvironment(environment), blockId('while-body'));
      if (ts.isDoStatement(statement)) processExpression(statement.expression, body, block);
      return mergeEnvironments(before, [before, body], statement, 'loop');
    }
    if (ts.isSwitchStatement(statement)) {
      processExpression(statement.expression, environment, block);
      const before = cloneEnvironment(environment);
      const branches = statement.caseBlock.clauses.map(clause => processStatementList(clause.statements, cloneEnvironment(before), 'switch-case'));
      if (!branches.length) branches.push(before);
      return mergeEnvironments(before, branches, statement, 'switch');
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      processExpression(statement.expression, environment, block);
      return environment;
    }
    if (ts.isTryStatement(statement)) {
      const before = cloneEnvironment(environment);
      const tryEnv = processStatement(statement.tryBlock, cloneEnvironment(before), blockId('try'));
      const catchEnv = statement.catchClause
        ? processStatement(statement.catchClause.block, cloneEnvironment(before), blockId('catch')) : before;
      const merged = mergeEnvironments(before, [tryEnv, catchEnv], statement, 'try');
      return statement.finallyBlock ? processStatement(statement.finallyBlock, merged, blockId('finally')) : merged;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) return environment;
    // Conservative fallback for statement kinds not modelled structurally.
    processExpression(statement, environment, block);
    return environment;
  };

  const rootEnvironment = new Map();
  const functionBlock = blockId('function');
  for (const parameter of functionNode?.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue;
    const target = symbolTarget(parameter.name);
    if (target) declareVersion({ ...target, node: parameter.name }, null, 'parameter', rootEnvironment, functionBlock);
  }
  if (functionNode?.body && ts.isBlock(functionNode.body)) {
    processStatementList(functionNode.body.statements, rootEnvironment, 'function-body');
  } else if (functionNode?.body) {
    processExpression(functionNode.body, rootEnvironment, functionBlock);
  }

  return {
    schemaVersion: '1.1',
    functionId: options.functionId ?? null,
    controlFlowGraph: options.controlFlowGraph ? {
      schemaVersion: options.controlFlowGraph.schemaVersion,
      entry: options.controlFlowGraph.entry,
      exit: options.controlFlowGraph.exit,
      nodeCount: options.controlFlowGraph.nodes.length,
      edgeCount: options.controlFlowGraph.edges.length,
    } : null,
    definitions,
    phiNodes,
    diagnostics,
    limits: { maxLoopIterations: 1, note: 'SSA records loop-carried merges; it does not unroll arbitrary runtime loops.' },
  };
}
