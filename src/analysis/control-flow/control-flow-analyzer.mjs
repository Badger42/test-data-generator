import { createLoopAnalyzer } from '../loops/loop-analyzer.mjs';

/**
 * Statement-level control-flow traversal. AST-specific operations, constraint
 * solving and scenario emission are provided by ports. This keeps this module
 * independent from TypeScript package loading, process-wide mutable state and JSON output.
 */
export function createControlFlowAnalyzer(ports) {
  const {
    ts,
    getPath,
    getLiteral,
    getBranchId,
    recordBranchOutcome,
    recordUnsupportedBranch,
    makeAssignment,
    combineSolutions,
    unsupportedSolution,
    addCustomSwitchScenario,
    typeAtPath,
    unionMembers,
    literalForType,
    sameValue,
    chooseDifferent,
    addScenarios,
    pathWithCondition,
    analyzeMcdcDecision,
    analyzeTernaries,
    analyzeArrayCallbacksInNode,
    expandCallbackLocalVariables,
    coverageAnchorMetadata,
    getMcdcDecisionId,
    maxAlternatives,
  } = ports;

  let analyzeStatementList;
  const loopAnalyzer = createLoopAnalyzer({
    ...ports.loopPorts,
    walkStatements: (statements, incoming, ctx) => analyzeStatementList(statements, incoming, ctx),
    maxAlternatives,
  });

  function mergeFlowResults(flows, ctx) {
    return flows.reduce((combined, flow) => ({
      normal: [...combined.normal, ...flow.normal].slice(0, maxAlternatives(ctx)),
      breaks: [...combined.breaks, ...flow.breaks].slice(0, maxAlternatives(ctx)),
      continues: [...combined.continues, ...flow.continues].slice(0, maxAlternatives(ctx)),
      returns: [...combined.returns, ...flow.returns].slice(0, maxAlternatives(ctx)),
    }), { normal: [], breaks: [], continues: [], returns: [] });
  }

  function analyzeSwitch(statement, incoming, ctx) {
    const discriminantPath = getPath(statement.expression);
    const cases = statement.caseBlock.clauses.filter(ts.isCaseClause).map(clause => ({ clause, literal: getLiteral(clause.expression) }));
    const defaultClause = statement.caseBlock.clauses.find(ts.isDefaultClause);
    const allLiteralsSupported = cases.every(item => item.literal.ok && (typeof item.literal.value === 'string' || typeof item.literal.value === 'number' || typeof item.literal.value === 'boolean'));
    const clauseFlows = [];
    for (const { clause, literal } of cases) {
      const clauseIndex = statement.caseBlock.clauses.indexOf(clause);
      const id = getBranchId('switch-case', clause, ctx.sourceFile);
      recordBranchOutcome(ctx, id, 'case', `switch-case:${id}`);
      const target = literal.ok && discriminantPath
        ? [makeAssignment(discriminantPath, literal.value)]
        : unsupportedSolution(`Unsupported switch case: ${clause.getText(ctx.sourceFile)}`);
      const combined = combineSolutions(incoming, target, ctx.maxAlternatives);
      addCustomSwitchScenario(ctx, id, clause.expression.getText(ctx.sourceFile), 'case', combined, clause, statement, clauseIndex);
      clauseFlows.push(analyzeStatementList(clause.statements, combined, ctx));
    }
    if (defaultClause) {
      const id = getBranchId('switch-default', defaultClause, ctx.sourceFile);
      recordBranchOutcome(ctx, id, 'default', `switch-default:${id}`);
      let target;
      if (discriminantPath && allLiteralsSupported) {
        const baseType = typeAtPath(discriminantPath, ctx.parameterMap, ctx.localMockMap, ctx.checker, statement);
        const choices = cases.map(item => item.literal.value);
        const unionCandidates = unionMembers(baseType).map(literalForType).filter(value => value !== undefined);
        const unusedUnionValue = unionCandidates.find(value => !choices.some(used => sameValue(used, value)));
        let other = unusedUnionValue !== undefined ? unusedUnionValue : chooseDifferent(choices[0], baseType);
        while (choices.some(value => sameValue(value, other))) other = typeof other === 'number' ? other + 1 : `${String(other)}_other`;
        target = [makeAssignment(discriminantPath, other)];
      } else target = unsupportedSolution('Cannot infer a default value for this switch discriminant.');
      const combined = combineSolutions(incoming, target, ctx.maxAlternatives);
      addCustomSwitchScenario(ctx, id, 'default', 'default', combined, defaultClause, statement, statement.caseBlock.clauses.indexOf(defaultClause));
      clauseFlows.push(analyzeStatementList(defaultClause.statements, combined, ctx));
    } else {
      clauseFlows.push({ normal: incoming, breaks: [], continues: [], returns: [] });
    }

    const merged = mergeFlowResults(clauseFlows, ctx);
    // `break` inside a switch exits the switch; `continue` still targets an outer loop.
    return {
      normal: [...merged.normal, ...merged.breaks].slice(0, maxAlternatives(ctx)),
      breaks: [],
      continues: merged.continues,
      returns: merged.returns,
    };
  }

  function analyzeIf(statement, incoming, ctx) {
    const sourceCondition = statement.expression;
    const callbackNode = ctx.activeAnalysisMetadata?.callbackNode;
    const condition = callbackNode ? expandCallbackLocalVariables(sourceCondition, callbackNode) : sourceCondition;
    const conditionText = sourceCondition.getText(ctx.sourceFile);
    analyzeMcdcDecision(condition, incoming, ctx, 'if', sourceCondition);
    analyzeTernaries(condition, incoming, ctx);
    // Istanbul's `if` branchMap location is the complete IfStatement (the `if`
    // keyword), whereas the solver target is the condition expression.
    const coverageAnchor = coverageAnchorMetadata(ctx.sourceFile, statement, 'if-statement');
    const runtimeDecisionId = getMcdcDecisionId('if', sourceCondition, ctx.sourceFile);
    addScenarios(ctx, 'if', sourceCondition, conditionText, true, incoming, null, condition, { ...coverageAnchor, runtimeDecisionId });
    addScenarios(ctx, 'if', sourceCondition, conditionText, false, incoming, null, condition, { ...coverageAnchor, runtimeDecisionId });
    const thenPath = pathWithCondition(incoming, condition, true, ctx);
    const elsePath = pathWithCondition(incoming, condition, false, ctx);
    const thenFlow = analyzeStatementList(ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement], thenPath, ctx);
    let elseFlow = { normal: elsePath, breaks: [], continues: [], returns: [] };
    if (statement.elseStatement) {
      if (ts.isIfStatement(statement.elseStatement)) elseFlow = analyzeIf(statement.elseStatement, elsePath, ctx);
      else elseFlow = analyzeStatementList(ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement], elsePath, ctx);
    }
    return mergeFlowResults([thenFlow, elseFlow], ctx);
  }

  analyzeStatementList = function analyzeStatementListImpl(statements, incoming, ctx) {
    let normal = incoming;
    const breaks = [];
    const continues = [];
    const returns = [];
    const absorb = flow => {
      breaks.push(...flow.breaks);
      continues.push(...flow.continues);
      returns.push(...flow.returns);
      normal = flow.normal;
    };

    for (const statement of statements) {
      if (!normal.length) break;

      if (ts.isIfStatement(statement)) {
        analyzeArrayCallbacksInNode(statement.expression, normal, ctx);
        absorb(analyzeIf(statement, normal, ctx));
        continue;
      }
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        if (statement.expression) {
          analyzeArrayCallbacksInNode(statement.expression, normal, ctx);
          analyzeTernaries(statement.expression, normal, ctx);
        }
        returns.push(...normal);
        normal = [];
        break;
      }
      if (ts.isBreakStatement(statement)) {
        breaks.push(...normal);
        normal = [];
        break;
      }
      if (ts.isContinueStatement(statement)) {
        continues.push(...normal);
        normal = [];
        break;
      }
      if (ts.isSwitchStatement(statement)) {
        absorb(analyzeSwitch(statement, normal, ctx));
        continue;
      }
      if (ts.isBlock(statement)) {
        absorb(analyzeStatementList(statement.statements, normal, ctx));
        continue;
      }
      if (ts.isForOfStatement(statement)) {
        absorb(loopAnalyzer.analyzeForEachLoop(statement, normal, ctx, false));
        continue;
      }
      if (ts.isForInStatement(statement)) {
        absorb(loopAnalyzer.analyzeForEachLoop(statement, normal, ctx, true));
        continue;
      }
      if (ts.isForStatement(statement)) {
        absorb(loopAnalyzer.analyzeClassicForLoop(statement, normal, ctx));
        continue;
      }
      if (ts.isWhileStatement(statement)) {
        absorb(loopAnalyzer.analyzeWhileLoop(statement, normal, ctx, false));
        continue;
      }
      if (ts.isDoStatement(statement)) {
        absorb(loopAnalyzer.analyzeWhileLoop(statement, normal, ctx, true));
        continue;
      }
      analyzeArrayCallbacksInNode(statement, normal, ctx);
      analyzeTernaries(statement, normal, ctx);
    }

    return {
      normal: normal.slice(0, maxAlternatives(ctx)),
      breaks: breaks.slice(0, maxAlternatives(ctx)),
      continues: continues.slice(0, maxAlternatives(ctx)),
      returns: returns.slice(0, maxAlternatives(ctx)),
    };
  };

  return {
    analyzeStatements: (statements, incoming, ctx) => analyzeStatementList(statements, incoming, ctx),
    analyzeIf,
    analyzeSwitch,
    mergeFlowResults,
    loopAnalyzer,
  };
}
