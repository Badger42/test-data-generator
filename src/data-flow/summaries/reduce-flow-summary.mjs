import { collectReferencedPaths, getSourceSpan } from '../ast-utils.mjs';
import { analyzeMutations } from '../mutation/mutation-analyzer.mjs';

function isFunctionLike(node, ts) {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node);
}

function collectReturns(callback, ts, sourceFile) {
  if (!callback?.body) return [];
  if (!ts.isBlock(callback.body)) return [{ expressionText: callback.body.getText(sourceFile), sourceSpan: getSourceSpan(callback.body, sourceFile, sourceFile.fileName) }];
  const returns = [];
  const visit = node => {
    if (!node || (node !== callback.body && isFunctionLike(node, ts))) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push({ expressionText: node.expression.getText(sourceFile), sourceSpan: getSourceSpan(node.expression, sourceFile, sourceFile.fileName) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return returns;
}

/** Collects descriptive accumulator-flow facts for inline Array.prototype.reduce callbacks. */
export function collectReduceFlowSummaries(functionNode, ts, checker, sourceFile, options = {}) {
  const summaries = [];
  const relativeFile = options.relativeFile ?? sourceFile.fileName;
  const visit = node => {
    if (!node) return;
    if (node !== functionNode && isFunctionLike(node, ts)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'reduce') {
      const callback = node.arguments[0];
      if (callback && isFunctionLike(callback, ts)) {
        const parameterName = index => {
          const parameter = callback.parameters[index];
          return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : null;
        };
        const accumulator = parameterName(0);
        const item = parameterName(1);
        const index = parameterName(2);
        const returns = collectReturns(callback, ts, sourceFile).map(result => {
          const expression = callback.body && ts.isBlock(callback.body)
            ? (() => {
              let found = null;
              const find = current => {
                if (!current || found || (current !== callback.body && isFunctionLike(current, ts))) return;
                if (ts.isReturnStatement(current) && current.expression?.getText(sourceFile) === result.expressionText) { found = current.expression; return; }
                ts.forEachChild(current, find);
              };
              find(callback.body);
              return found;
            })()
            : callback.body;
          const dependencies = expression ? collectReferencedPaths(expression, ts, checker).map(reference => reference.text) : [];
          return {
            ...result,
            dependencies,
            dependsOnAccumulator: accumulator ? dependencies.some(path => path === accumulator || path.startsWith(`${accumulator}.`)) : false,
            dependsOnItem: item ? dependencies.some(path => path === item || path.startsWith(`${item}.`)) : false,
          };
        });
        const effects = analyzeMutations(callback, ts, checker, sourceFile, [], { relativeFile });
        const hasAccumulatorRecurrence = returns.some(result => result.dependsOnAccumulator);
        const callbackSpan = getSourceSpan(callback, sourceFile, relativeFile);
        summaries.push({
          id: `reduce:${node.getStart(sourceFile)}`,
          collectionExpression: node.expression.expression.getText(sourceFile),
          sourceSpan: getSourceSpan(node, sourceFile, relativeFile),
          callbackSourceSpan: callbackSpan,
          accumulator: accumulator ? { name: accumulator, parameterIndex: 0 } : null,
          item: item ? { name: item, parameterIndex: 1 } : null,
          index: index ? { name: index, parameterIndex: 2 } : null,
          initialValue: node.arguments.length > 1 ? { provided: true, expressionText: node.arguments[1].getText(sourceFile) } : { provided: false },
          returns,
          hasAccumulatorRecurrence,
          stateful: hasAccumulatorRecurrence || effects.some(effect => effect.kind !== 'returned-reference'),
          effects: effects.map(effect => ({ kind: effect.kind, path: effect.path, certainty: effect.certainty, sourceSpan: effect.sourceSpan })),
          confidence: returns.length && accumulator && item ? 'medium' : 'low',
          executionModel: 'bounded-callback-interpretation',
          note: 'Descriptive accumulator flow only; this summary does not replace runtime callback interpretation or prove arbitrary iteration behavior.',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);
  return summaries;
}
