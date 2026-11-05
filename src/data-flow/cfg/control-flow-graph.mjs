import { getSourceSpan } from '../ast-utils.mjs';

function isFunctionLike(node, ts) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration?.(node);
}

/**
 * Builds a deterministic CFG for one function. Statements are represented as
 * structural nodes, while short-circuit and conditional expressions are expanded
 * into expression-condition nodes so branch edges preserve evaluation order.
 * Exception origins inside arbitrary calls remain conservative.
 */
export function buildControlFlowGraph(functionNode, ts, sourceFile, options = {}) {
  if (!functionNode || !ts || !sourceFile) throw new TypeError('ControlFlowGraph requires function AST, TypeScript API and source file.');
  const relativeFile = options.relativeFile ?? sourceFile.fileName;
  const nodes = [];
  const edges = [];
  const nodeById = new Map();
  const edgeKeys = new Set();
  let syntheticSequence = 0;

  const addNode = (kind, astNode = null, extra = {}) => {
    const span = astNode ? getSourceSpan(astNode, sourceFile, relativeFile) : null;
    const position = span?.startOffset ?? 'synthetic';
    const id = `${kind}:${position}:${++syntheticSequence}`;
    const node = { id, kind, ...(span ? { sourceSpan: span } : {}), ...extra };
    nodes.push(node);
    nodeById.set(id, node);
    return id;
  };
  const addEdge = (from, to, kind = 'normal', extra = {}) => {
    if (!from || !to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind, ...extra });
  };
  const connect = (frontier, target, kind = 'normal') => {
    for (const from of frontier ?? []) addEdge(from, target, kind);
  };
  const compileConditionExpression = (expression, trueTarget, falseTarget) => {
    let current = expression;
    while (current && ts.isParenthesizedExpression(current)) current = current.expression;
    if (!current) return null;
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
      return compileConditionExpression(current.operand, falseTarget, trueTarget);
    }
    if (ts.isBinaryExpression(current) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(current.operatorToken.kind)) {
      const isAnd = current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
      const rightEntry = compileConditionExpression(current.right, trueTarget, falseTarget);
      return compileConditionExpression(current.left, isAnd ? rightEntry : trueTarget, isAnd ? falseTarget : rightEntry);
    }
    if (ts.isConditionalExpression(current)) {
      const trueEntry = compileConditionExpression(current.whenTrue, trueTarget, falseTarget);
      const falseEntry = compileConditionExpression(current.whenFalse, trueTarget, falseTarget);
      return compileConditionExpression(current.condition, trueEntry, falseEntry);
    }
    const condition = addNode('expression-condition', current, { expression: current.getText(sourceFile) });
    addEdge(condition, trueTarget, 'true');
    addEdge(condition, falseTarget, 'false');
    return condition;
  };
  const entry = addNode('entry');
  const exit = addNode('exit');

  const isTerminatingClause = statements => {
    const last = statements?.[statements.length - 1];
    return Boolean(last && (ts.isBreakStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isContinueStatement(last)));
  };

  const compileList = (statements, incoming, context) => {
    let frontier = [...incoming];
    for (const statement of statements ?? []) {
      if (!frontier.length) break;
      frontier = compileStatement(statement, frontier, context);
    }
    return frontier;
  };

  const compileLoop = (statement, incoming, context, kind) => {
    const header = addNode(`${kind}-header`, statement, {
      condition: (statement.condition ?? statement.expression)?.getText?.(sourceFile) ?? null,
    });
    const after = addNode(`${kind}-exit`, statement);
    const loopStatementStart = getSourceSpan(statement, sourceFile, relativeFile)?.startOffset ?? null;
    const bodyEntry = addNode(`${kind}-body-entry`, statement.statement, { loopStatementStart });
    if (kind === 'for') {
      let preheader = [...incoming];
      if (statement.initializer) {
        const init = addNode('for-initializer', statement.initializer, {
          text: statement.initializer.getText(sourceFile),
        });
        connect(preheader, init);
        preheader = [init];
      }
      connect(preheader, header);
      const increment = statement.incrementor
        ? addNode('for-incrementor', statement.incrementor, { text: statement.incrementor.getText(sourceFile) })
        : header;
      const loopContext = { ...context, breakTarget: after, continueTarget: increment };
      if (statement.condition) {
        const conditionEntry = compileConditionExpression(statement.condition, bodyEntry, after);
        addEdge(header, conditionEntry, 'evaluate');
      } else addEdge(header, bodyEntry, 'true');
      const bodyFrontier = compileStatement(statement.statement, [bodyEntry], loopContext);
      if (statement.incrementor) {
        connect(bodyFrontier, increment, 'normal');
        addEdge(increment, header, 'back');
      } else connect(bodyFrontier, header, 'back');
      return [after];
    }
    if (kind === 'for-of' || kind === 'for-in') {
      connect(incoming, header);
      const binding = addNode('for-each-binding', statement.initializer, {
        text: statement.initializer?.getText?.(sourceFile) ?? null,
      });
      const loopContext = { ...context, breakTarget: after, continueTarget: header };
      addEdge(header, binding, 'iteration');
      addEdge(header, after, 'exhausted');
      const bodyFrontier = compileStatement(statement.statement, [binding], loopContext);
      connect(bodyFrontier, header, 'back');
      return [after];
    }
    const loopContext = { ...context, breakTarget: after, continueTarget: header };
    if (kind === 'do') {
      // do/while executes the body at least once, then reaches its condition.
      connect(incoming, bodyEntry);
      const bodyFrontier = compileStatement(statement.statement, [bodyEntry], loopContext);
      connect(bodyFrontier, header, 'back');
      const condition = statement.condition ?? statement.expression;
      const conditionEntry = compileConditionExpression(condition, bodyEntry, after);
      addEdge(header, conditionEntry, 'evaluate');
      return [after];
    }
    connect(incoming, header);
    const condition = statement.condition ?? statement.expression;
    if (condition) {
      const conditionEntry = compileConditionExpression(condition, bodyEntry, after);
      addEdge(header, conditionEntry, 'evaluate');
    } else addEdge(header, bodyEntry, 'true');
    const bodyFrontier = compileStatement(statement.statement, [bodyEntry], loopContext);
    connect(bodyFrontier, header, 'back');
    return [after];
  };

  const compileStatement = (statement, incoming, context = {}) => {
    if (!statement) return incoming;
    if (statement !== functionNode && isFunctionLike(statement, ts)) return incoming;
    if (ts.isBlock(statement)) {
      const blockEntry = addNode('block-entry', statement);
      connect(incoming, blockEntry);
      const frontier = compileList(statement.statements, [blockEntry], context);
      const blockExit = addNode('block-exit', statement);
      connect(frontier, blockExit);
      return frontier.length ? [blockExit] : [];
    }
    if (ts.isIfStatement(statement)) {
      const condition = addNode('if-condition', statement, { expression: statement.expression.getText(sourceFile) });
      connect(incoming, condition);
      const join = addNode('if-join', statement);
      const thenEntry = addNode('if-then-entry', statement.thenStatement);
      let elseEntry;
      if (statement.elseStatement) elseEntry = addNode('if-else-entry', statement.elseStatement);
      const conditionEntry = compileConditionExpression(statement.expression, thenEntry, elseEntry ?? join);
      addEdge(condition, conditionEntry, 'evaluate');
      const thenFrontier = compileStatement(statement.thenStatement, [thenEntry], context);
      connect(thenFrontier, join);
      if (statement.elseStatement) {
        const elseFrontier = compileStatement(statement.elseStatement, [elseEntry], context);
        connect(elseFrontier, join);
      }
      const hasIncoming = edges.some(edge => edge.to === join);
      return hasIncoming ? [join] : [];
    }
    if (ts.isForStatement(statement)) return compileLoop(statement, incoming, context, 'for');
    if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) return compileLoop(statement, incoming, context, ts.isForOfStatement(statement) ? 'for-of' : 'for-in');
    if (ts.isWhileStatement(statement)) return compileLoop(statement, incoming, context, 'while');
    if (ts.isDoStatement(statement)) return compileLoop(statement, incoming, context, 'do');
    if (ts.isSwitchStatement(statement)) {
      const selector = addNode('switch-selector', statement, { expression: statement.expression.getText(sourceFile) });
      connect(incoming, selector);
      const join = addNode('switch-join', statement);
      const clauses = statement.caseBlock.clauses;
      const switchContext = { ...context, breakTarget: join };
      let fallthrough = [];
      let hasDefault = false;
      for (const clause of clauses) {
        const isDefault = clause.kind === ts.SyntaxKind.DefaultClause;
        hasDefault ||= isDefault;
        const label = isDefault ? 'default' : clause.expression.getText(sourceFile);
        const clauseEntry = addNode('switch-clause', clause, { label, default: isDefault });
        addEdge(selector, clauseEntry, isDefault ? 'default' : 'case', { label });
        connect(fallthrough, clauseEntry, 'fallthrough');
        const clauseFrontier = compileList(clause.statements, [clauseEntry], switchContext);
        fallthrough = isTerminatingClause(clause.statements) ? [] : clauseFrontier;
      }
      connect(fallthrough, join, 'normal');
      if (!hasDefault) addEdge(selector, join, 'unmatched');
      return [join];
    }
    if (ts.isTryStatement(statement)) {
      const tryEntry = addNode('try-entry', statement);
      connect(incoming, tryEntry);
      const join = addNode('try-join', statement);
      const tryFrontier = compileStatement(statement.tryBlock, [tryEntry], context);
      connect(tryFrontier, join, 'normal');
      if (statement.catchClause) {
        const catchEntry = addNode('catch-entry', statement.catchClause);
        addEdge(tryEntry, catchEntry, 'exception');
        const catchFrontier = compileStatement(statement.catchClause.block, [catchEntry], context);
        connect(catchFrontier, join, 'normal');
      }
      if (statement.finallyBlock) {
        const finallyEntry = addNode('finally-entry', statement.finallyBlock);
        addEdge(join, finallyEntry, 'finally');
        const finallyFrontier = compileStatement(statement.finallyBlock, [finallyEntry], context);
        return finallyFrontier;
      }
      return [join];
    }
    if (ts.isBreakStatement(statement)) {
      const node = addNode('break', statement, { label: statement.label?.text ?? null });
      connect(incoming, node);
      if (context.breakTarget) addEdge(node, context.breakTarget, 'break');
      else addEdge(node, exit, 'unresolved-break');
      return [];
    }
    if (ts.isContinueStatement(statement)) {
      const node = addNode('continue', statement, { label: statement.label?.text ?? null });
      connect(incoming, node);
      if (context.continueTarget) addEdge(node, context.continueTarget, 'continue');
      else addEdge(node, exit, 'unresolved-continue');
      return [];
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const kind = ts.isReturnStatement(statement) ? 'return' : 'throw';
      const node = addNode(kind, statement, { expression: statement.expression?.getText?.(sourceFile) ?? null });
      connect(incoming, node);
      addEdge(node, exit, kind);
      return [];
    }
    if (ts.isLabeledStatement(statement)) return compileStatement(statement.statement, incoming, context);

    const kind = ts.isVariableStatement(statement) ? 'declaration'
      : ts.isExpressionStatement(statement) ? 'expression'
        : ts.isEmptyStatement(statement) ? 'empty'
          : ts.SyntaxKind[statement.kind] ?? 'statement';
    const node = addNode(kind, statement, { text: statement.getText(sourceFile) });
    connect(incoming, node);
    return [node];
  };

  const body = functionNode.body;
  const frontier = body && ts.isBlock(body)
    ? compileList(body.statements, [entry], { breakTarget: null, continueTarget: null })
    : body ? compileStatement(body, [entry], { breakTarget: null, continueTarget: null }) : [entry];
  connect(frontier, exit);

  return Object.freeze({
    schemaVersion: '1.0',
    functionId: options.functionId ?? null,
    granularity: 'statement-and-boolean-expression',
    entry,
    exit,
    nodes: Object.freeze(nodes.map(node => Object.freeze(node))),
    edges: Object.freeze(edges.map(edge => Object.freeze(edge))),
    diagnostics: Object.freeze([
      ...nodes.filter(node => ['break', 'continue'].includes(node.kind) && edges.some(edge => edge.from === node.id && edge.kind.startsWith('unresolved-')))
        .map(node => ({ code: 'UNRESOLVED_CONTROL_TRANSFER', message: `${node.kind} target could not be resolved structurally.`, sourceSpan: node.sourceSpan })),
    ]),
    limits: Object.freeze({ expressionLevelBranches: true, expressionOperators: ['&&', '||', '!', '?:'], exceptionOrigins: 'conservative-try-entry', arbitraryLoopUnrolling: false, labelledControlTransfers: false, forLoopOperationsSeparated: true }),
  });
}
