/**
 * TypeScript-aware array callback discovery and pipeline context composition.
 * This is a front-end adapter: it consumes injected AST/path/solver operations
 * and returns bounded aliases and pipeline facts, without owning analysis state.
 */
import { createArrayCallbackDiscovery } from './callback-discovery.mjs';
import { createArrayPipelineComposer } from './pipeline/pipeline-composer.mjs';

export function createArrayPipelineRuntime(dependencies) {
  const {
    ts, unwrap, getPathWithAliases, getLiteral, getPath, getNodeText,
    isFunctionLikeCallback, isSafeCallbackLocalInitializer,
    callbackMethods, reduceMethods, comparatorMethods,
    getCallbackPredicateSourceExpression, getCallbackPredicateExpression,
    serializable, substituteKnownAliases, extractAffineForm,
    solveCondition, unsupportedSolution, combineSolutions, makeAssignment,
  } = dependencies;
  if (!ts || typeof getPathWithAliases !== 'function' || typeof solveCondition !== 'function') {
    throw new TypeError('ArrayPipelineRuntime requires TypeScript, path resolution and condition solving ports.');
  }

let arrayCallbackDiscoveryInstance;
function getArrayCallbackDiscovery() {
  if (!arrayCallbackDiscoveryInstance) {
    arrayCallbackDiscoveryInstance = createArrayCallbackDiscovery({
      ts,
      unwrap,
      getPathWithAliases,
      getLiteral,
      isFunctionLikeCallback,
      callbackMethods: callbackMethods,
      reduceMethods: reduceMethods,
      comparatorMethods: comparatorMethods,
    });
  }
  return arrayCallbackDiscoveryInstance;
}
function getArrayReceiverModel(receiver, ctx) {
  return getArrayCallbackDiscovery().getReceiverModel(receiver, ctx);
}
function getArrayCallbackDescriptor(call, ctx) {
  return getArrayCallbackDiscovery().getDescriptor(call, ctx);
}

function getCallbackSingleReturnExpression(callback) {
  if (!callback) return null;
  if (!ts.isBlock(callback.body)) return callback.body;
  const returns = callback.body.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0].expression ?? null : null;
}

function deriveMappedItemAlias(callback, currentAlias, aliases) {
  const expression = getCallbackSingleReturnExpression(callback);
  if (!expression) return null;
  const callbackAliases = new Map(aliases);
  const parameter = callback.parameters?.[0];
  if (parameter && ts.isIdentifier(parameter.name)) callbackAliases.set(parameter.name.text, currentAlias);

  const literal = getLiteral(expression);
  if (literal.ok) return { kind: 'constant', value: literal.value };
  const path = getPathWithAliases(expression, callbackAliases);
  if (path) return { kind: 'path', path };

  const value = unwrap(expression);
  if (value && ts.isObjectLiteralExpression(value)) {
    const fields = {};
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text : null;
        if (key === null) continue;
        const fieldLiteral = getLiteral(property.initializer);
        if (fieldLiteral.ok) fields[key] = { kind: 'constant', value: fieldLiteral.value };
        else {
          const fieldPath = getPathWithAliases(property.initializer, callbackAliases);
          if (fieldPath) fields[key] = { kind: 'path', path: fieldPath };
          else if (isSafeCallbackLocalInitializer(property.initializer)) {
            fields[key] = {
              kind: 'computed',
              expression: property.initializer,
              aliases: new Map(callbackAliases),
              sourceText: getNodeText(property.initializer, expression.getSourceFile()),
            };
          }
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const fieldPath = getPathWithAliases(property.name, callbackAliases);
        if (fieldPath) fields[property.name.text] = { kind: 'path', path: fieldPath };
      }
    }
    if (Object.keys(fields).length) return { kind: 'object', fields };
  }
  return null;
}

function aliasPathText(alias) {
  if (!alias) return 'unknown';
  if (alias.kind === 'path') {
    return alias.path.reduce((text, part, index) => index === 0
      ? part
      : /^\d+$/.test(part) ? `${text}[${part}]` : `${text}.${part}`, '');
  }
  if (alias.kind === 'constant') return JSON.stringify(alias.value);
  if (alias.kind === 'object') {
    return `{ ${Object.entries(alias.fields ?? {}).map(([key, value]) => `${key}: ${aliasPathText(value)}`).join(', ')} }`;
  }
  if (alias.kind === 'computed') return alias.sourceText ?? '<computed>';
  return 'unknown';
}

function aliasMetadata(alias) {
  if (!alias) return { kind: 'unknown' };
  if (alias.kind === 'path') return { kind: 'path', path: alias.path };
  if (alias.kind === 'constant') return { kind: 'constant', value: serializable(alias.value) };
  if (alias.kind === 'object') return {
    kind: 'object',
    fields: Object.fromEntries(Object.entries(alias.fields ?? {}).map(([key, value]) => [key, aliasMetadata(value)])),
  };
  if (alias.kind === 'computed') return { kind: 'computed', expression: alias.sourceText ?? '<computed>' };
  return { kind: alias.kind ?? 'unknown' };
}

function bindCallbackParameters(callback, aliases, itemAlias, indexValue) {
  const [itemParameter, indexParameter] = callback?.parameters ?? [];
  if (itemParameter && ts.isIdentifier(itemParameter.name)) aliases.set(itemParameter.name.text, itemAlias);
  if (indexParameter && ts.isIdentifier(indexParameter.name)) aliases.set(indexParameter.name.text, { kind: 'constant', value: indexValue });
  return aliases;
}

let arrayPipelineComposerInstance;
function getArrayPipelineComposer() {
  if (!arrayPipelineComposerInstance) {
    arrayPipelineComposerInstance = createArrayPipelineComposer({
      ts,
      comparatorMethods: comparatorMethods,
      getCallbackSingleReturnExpression,
      bindCallbackParameters,
      deriveMappedItemAlias,
      getCallbackPredicateSourceExpression,
      getNodeText,
      aliasPathText,
      aliasMetadata,
      inferComparatorOrder,
      comparatorOrderSolutions,
      getCallbackPredicateExpression,
      solveCondition,
      unsupportedSolution,
      combineSolutions,
    });
  }
  return arrayPipelineComposerInstance;
}
function mapArrayAliasThroughStages(descriptor, sourceIndex, stageLimit, ctx) {
  return getArrayPipelineComposer().mapElementThroughStages(descriptor, sourceIndex, stageLimit, ctx);
}

function inferComparatorOrder(stage, leftAlias, rightAlias, ctx) {
  if (!stage.callback) return null;
  const expression = getCallbackSingleReturnExpression(stage.callback);
  if (!expression) return null;
  const [leftParameter, rightParameter] = stage.callback.parameters;
  if (!leftParameter || !rightParameter || !ts.isIdentifier(leftParameter.name) || !ts.isIdentifier(rightParameter.name)) return null;
  const aliases = new Map(ctx.pathAliases);
  aliases.set(leftParameter.name.text, leftAlias);
  aliases.set(rightParameter.name.text, rightAlias);

  const original = unwrap(expression);
  const normalized = unwrap(substituteKnownAliases(expression, aliases));
  if (ts.isBinaryExpression(original) && original.operatorToken.kind === ts.SyntaxKind.MinusToken && ts.isBinaryExpression(normalized) && normalized.operatorToken.kind === ts.SyntaxKind.MinusToken) {
    const rawLeftPath = getPath(original.left);
    const rawRightPath = getPath(original.right);
    let direction = 'ascending';
    if (rawLeftPath?.[0] === rightParameter.name.text && rawRightPath?.[0] === leftParameter.name.text) direction = 'descending';
    const leftForm = extractAffineForm(normalized.left, new Map());
    const rightForm = extractAffineForm(normalized.right, new Map());
    if (leftForm && rightForm) {
      if (direction === 'descending') return { direction, leftForm: rightForm, rightForm: leftForm, evidence: 'rightKey - leftKey' };
      return { direction, leftForm, rightForm, evidence: 'leftKey - rightKey' };
    }
  }

  if (ts.isConditionalExpression(normalized)) {
    const condition = unwrap(normalized.condition);
    const whenTrue = getLiteral(normalized.whenTrue);
    const whenFalse = getLiteral(normalized.whenFalse);
    if (condition && ts.isBinaryExpression(condition) && whenTrue.ok && whenFalse.ok &&
        typeof whenTrue.value === 'number' && typeof whenFalse.value === 'number' &&
        Math.sign(whenTrue.value) !== Math.sign(whenFalse.value)) {
      const leftForm = extractAffineForm(condition.left, new Map());
      const rightForm = extractAffineForm(condition.right, new Map());
      if (leftForm && rightForm) {
        const relational = condition.operatorToken.kind;
        const trueBranchMeansAscending = [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken].includes(relational);
        const trueBranchMeansDescending = [ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(relational);
        const direction = (trueBranchMeansAscending && whenTrue.value < 0) || (trueBranchMeansDescending && whenTrue.value > 0)
          ? 'ascending' : 'descending';
        return { direction, leftForm, rightForm, evidence: 'conditional comparator with opposite-sign return values' };
      }
    }
  }

  if (ts.isCallExpression(normalized)) {
    const methodExpression = unwrap(normalized.expression);
    if (methodExpression && ts.isPropertyAccessExpression(methodExpression) && methodExpression.name.text === 'localeCompare') {
      const leftForm = extractAffineForm(methodExpression.expression, new Map());
      const rightForm = normalized.arguments[0] ? extractAffineForm(normalized.arguments[0], new Map()) : null;
      if (leftForm && rightForm) return { direction: 'ascending', leftForm, rightForm, evidence: 'leftKey.localeCompare(rightKey)' };
    }
  }
  return null;
}

function comparatorOrderSolutions(order, context) {
  const candidates = [-10, -1, 0, 1, 2, 5, 10, 20, 50, 100];
  const leftHasPath = Boolean(order.leftForm.path);
  const rightHasPath = Boolean(order.rightForm.path);
  if (!leftHasPath && !rightHasPath) return [{ assignments: new Map(), unsupported: [] }];
  const solutions = [];
  const seen = new Set();
  // Vary the left-hand input representative first so downstream predicates on
  // item 0 can still find compatible values; then choose a matching right item.
  for (const leftInput of (leftHasPath ? candidates : [null])) {
    let matchedRight = false;
    for (const rightInput of (rightHasPath ? candidates : [null])) {
      const leftValue = leftHasPath ? order.leftForm.coefficient * leftInput + order.leftForm.offset : order.leftForm.constant;
      const rightValue = rightHasPath ? order.rightForm.coefficient * rightInput + order.rightForm.offset : order.rightForm.constant;
      const ordered = order.direction === 'ascending' ? leftValue <= rightValue : leftValue >= rightValue;
      if (!ordered) continue;
      let combined = [{ assignments: new Map(), unsupported: [] }];
      if (leftHasPath) combined = combineSolutions(combined, [makeAssignment(order.leftForm.path, leftInput)], context.maxAlternatives);
      if (rightHasPath && (!leftHasPath || order.rightForm.path.join('.') !== order.leftForm.path.join('.'))) {
        combined = combineSolutions(combined, [makeAssignment(order.rightForm.path, rightInput)], context.maxAlternatives);
      }
      for (const solution of combined) {
        const fingerprint = JSON.stringify([...solution.assignments].map(([key, value]) => [key, value.value]));
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        solutions.push(solution);
      }
      matchedRight = true;
      break;
    }
    if (solutions.length >= 12) break;
    if (!matchedRight) continue;
  }
  return solutions;
}

function getArrayPipelineContext(descriptor, itemIndex, ctx, callbackIndex = itemIndex) {
  return getArrayPipelineComposer().getPipelineContext(descriptor, itemIndex, ctx, callbackIndex);
}



  return Object.freeze({
    getArrayReceiverModel,
    getArrayCallbackDescriptor,
    getArrayPipelineContext,
    getCallbackSingleReturnExpression,
    deriveMappedItemAlias,
    aliasPathText,
    aliasMetadata,
    bindCallbackParameters,
    mapArrayAliasThroughStages,
    inferComparatorOrder,
    comparatorOrderSolutions,
  });
}
