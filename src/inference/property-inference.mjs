/**
 * TypeScript-aware structural inference from observed AST usage.
 * All AST/path/array interpretation operations are injected so this module
 * owns inference policy, not project loading or analysis orchestration.
 */
import {
  ARRAY_CALLBACK_METHODS,
  ARRAY_REDUCE_METHODS,
  ARRAY_PREDICATE_METHODS,
  ARRAY_COMPARATOR_METHODS,
} from '../domain/array-method-policy.mjs';

const MAX_DEPTH = 4;
const STRING_METHODS = new Set([
  'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'includes',
  'indexOf', 'lastIndexOf', 'match', 'matchAll', 'normalize', 'padEnd', 'padStart',
  'repeat', 'replace', 'replaceAll', 'search', 'slice', 'split', 'startsWith',
  'substring', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart', 'toString', 'valueOf',
]);
const ARRAY_METHODS = new Set([
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach', 'includes',
  'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push', 'reduce',
  'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice', 'toReversed',
  'toSorted', 'toSpliced', 'unshift', 'values',
]);

function isComparisonOperator(kind, ts) {
  return [
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ].includes(kind);
}

export function createPropertyInference(dependencies) {
  const {
    ts, unwrap, getPathWithAliases, getPathAndLiteralWithAliases, getTwoPathsWithAliases,
    getLiteral, getLoopVariableName, getLoopInitialValue, findLengthCollectionPath,
    getArrayReceiverModel, isFunctionLikeCallback, getCallbackPredicateExpression,
    evaluateReduceExpression, deriveMappedItemAlias,
  } = dependencies;
  if (!ts || !getPathWithAliases || !getLiteral) {
    throw new TypeError('PropertyInference requires TypeScript and AST/path operations.');
  }
  const comparisonOperator = kind => isComparisonOperator(kind, ts);

function inferPropertyModel(fn, sourceFile, parameterNames, initialAliases = new Map()) {
  const parameterSet = new Set(parameterNames);
  const inferred = new Map();
  const priorities = { unknown: 0, boolean: 2, string: 3, number: 3, array: 5, object: 5 };

  function set(pathParts, kind, confidence, evidence, priority = priorities[kind] ?? 1) {
    if (!pathParts?.length || !parameterSet.has(pathParts[0])) return;
    const key = pathParts.join('.');
    const existing = inferred.get(key);
    if (existing && existing.priority > priority) return;
    if (existing && existing.priority === priority && existing.kind !== kind) {
      existing.kind = 'unknown';
      existing.confidence = 'low';
      existing.evidence = [...new Set([...existing.evidence, evidence, `Conflicting evidence: ${existing.kind} vs ${kind}`])];
      return;
    }
    inferred.set(key, {
      path: key,
      kind,
      confidence,
      evidence: [...new Set([...(existing?.evidence ?? []), evidence])],
      priority,
    });
  }

  function addStructure(pathParts) {
    for (let i = 1; i < pathParts.length; i += 1) {
      const prefix = pathParts.slice(0, i);
      const nextPart = pathParts[i];
      const kind = /^\d+$/.test(nextPart) ? 'array' : 'object';
      set(prefix, kind, 'medium', `Inferred from nested property access: ${pathParts.join('.')}`, 5);
    }
  }

  function recordPath(pathParts, kind, confidence, evidence, priority) {
    if (!pathParts || !parameterSet.has(pathParts[0])) return;
    addStructure(pathParts);
    set(pathParts, kind, confidence, evidence, priority);
  }

  function recordArithmeticOperandPaths(root, aliases) {
    function visitArithmetic(node) {
      if (!node) return;
      const current = unwrap(node);
      if (current && ts.isBinaryExpression(current) && [
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.PlusEqualsToken,
        ts.SyntaxKind.MinusEqualsToken,
      ].includes(current.operatorToken.kind)) {
        for (const operand of [current.left, current.right]) {
          const pathParts = getPathWithAliases(operand, aliases);
          if (pathParts && parameterSet.has(pathParts[0])) {
            recordPath(pathParts, 'number', 'medium', 'Used as an arithmetic operand in reduce() callback', 3);
          }
        }
      }
      ts.forEachChild(current, visitArithmetic);
    }
    visitArithmetic(root);
  }

  function recordCondition(node, aliases = new Map()) {
    const current = unwrap(node);
    if (!current) return;
    if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
      recordCondition(current.operand, aliases);
      return;
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        recordCondition(current.left, aliases);
        recordCondition(current.right, aliases);
        return;
      }
      if (comparisonOperator(operator)) {
        const pair = getPathAndLiteralWithAliases(current.left, current.right, aliases);
        if (pair && parameterSet.has(pair.path[0])) {
          const value = pair.literal;
          if (pair.path[pair.path.length - 1] === 'length' && typeof value === 'number') {
            recordPath(pair.path.slice(0, -1), 'sequence', 'medium', '.length is shared by strings and arrays; the field type is ambiguous without more evidence', 3);
          } else if (typeof value === 'number') {
            recordPath(pair.path, 'number', 'high', `Compared with numeric literal ${value}`, 4);
          } else if (typeof value === 'string') {
            recordPath(pair.path, 'string', 'high', `Compared with string literal ${JSON.stringify(value)}`, 4);
          } else if (typeof value === 'boolean') {
            recordPath(pair.path, 'boolean', 'high', `Compared with boolean literal ${value}`, 4);
          }
        } else {
          const paths = getTwoPathsWithAliases(current.left, current.right, aliases);
          if (paths && parameterSet.has(paths.leftPath[0]) && parameterSet.has(paths.rightPath[0]) &&
              [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(operator)) {
            recordPath(paths.leftPath, 'number', 'medium', 'Compared numerically with another input property', 3);
            recordPath(paths.rightPath, 'number', 'medium', 'Compared numerically with another input property', 3);
          }
        }
        return;
      }
    }
    const pathParts = getPathWithAliases(current, aliases);
    if (pathParts && parameterSet.has(pathParts[0])) {
      if (pathParts[pathParts.length - 1] === 'length' && pathParts.length > 1) {
        recordPath(pathParts.slice(0, -1), 'sequence', 'medium', 'Used through .length; string/array kind is ambiguous without type information', 3);
      } else {
        recordPath(pathParts, 'boolean', 'heuristic', 'Used directly as a truthy/falsy condition; boolean is a representative value', 2);
      }
    }
  }

  function visit(node, aliases = new Map()) {
    if (ts.isForOfStatement(node)) {
      const collectionPath = getPathWithAliases(node.expression, aliases);
      if (collectionPath && parameterSet.has(collectionPath[0])) {
        recordPath(collectionPath, 'array', 'medium', 'Used as a for...of iterable', 5);
      }
      const loopName = ts.isVariableDeclarationList(node.initializer)
        ? getLoopVariableName(node.initializer)
        : ts.isIdentifier(node.initializer) ? node.initializer.text : null;
      const nestedAliases = new Map(aliases);
      if (loopName && collectionPath) nestedAliases.set(loopName, { kind: 'path', path: [...collectionPath, '0'] });
      visit(node.statement, nestedAliases);
      return;
    }

    if (ts.isForInStatement(node)) {
      const collectionPath = getPathWithAliases(node.expression, aliases);
      if (collectionPath && parameterSet.has(collectionPath[0])) {
        recordPath(collectionPath, 'object', 'medium', 'Used as a for...in iterable', 5);
      }
      const loopName = ts.isVariableDeclarationList(node.initializer)
        ? getLoopVariableName(node.initializer)
        : ts.isIdentifier(node.initializer) ? node.initializer.text : null;
      const nestedAliases = new Map(aliases);
      if (loopName && collectionPath) nestedAliases.set(loopName, { kind: 'key', value: '__branch_scenario_key__' });
      visit(node.statement, nestedAliases);
      return;
    }

    if (ts.isForStatement(node)) {
      if (node.condition) recordCondition(node.condition, aliases);
      const loopName = getLoopVariableName(node.initializer);
      const collectionPath = findLengthCollectionPath(node.condition, aliases);
      if (collectionPath && parameterSet.has(collectionPath[0])) {
        recordPath(collectionPath, 'array', 'medium', 'Length is used as the bound of a for-loop', 5);
      }
      const nestedAliases = new Map(aliases);
      const initialIndex = getLoopInitialValue(node.initializer, loopName);
      const index = initialIndex.ok && Number.isInteger(initialIndex.value) && initialIndex.value >= 0 && initialIndex.value <= 7
        ? initialIndex.value : 0;
      if (loopName) nestedAliases.set(loopName, { kind: 'index', index });
      visit(node.statement, nestedAliases);
      // Analyze expressions in the initializer and incrementor for nested calls/conditions.
      if (node.initializer) visit(node.initializer, aliases);
      if (node.incrementor) visit(node.incrementor, nestedAliases);
      return;
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrap(node.expression))) {
      const callExpression = unwrap(node.expression);
      const method = callExpression.name.text;
      const inferenceContext = {
        pathAliases: aliases,
        parameterMap: new Map([...parameterNames].map(name => [name, {}])),
      };
      const receiverModel = getArrayReceiverModel(callExpression.expression, inferenceContext);
      const receiverPath = receiverModel?.collectionPath ?? getPathWithAliases(callExpression.expression, aliases);
      if (receiverPath && parameterSet.has(receiverPath[0])) {
        if (STRING_METHODS.has(method)) {
          recordPath(receiverPath, 'string', 'medium', `Used with string method ${method}()`, 4);
        } else if (ARRAY_METHODS.has(method)) {
          recordPath(receiverPath, 'array', 'medium', `Used with array method ${method}()`, 4);
          if (method === 'flat') {
            const depthLiteral = node.arguments.length ? getLiteral(node.arguments[0]) : { ok: true, value: 1 };
            const depth = depthLiteral.ok && typeof depthLiteral.value === 'number'
              ? Math.max(0, Math.min(3, Math.floor(depthLiteral.value))) : 1;
            for (let level = 1; level <= depth; level += 1) {
              recordPath([...receiverPath, ...Array(level).fill('0')], 'array', 'medium', `Nested array level inferred from flat(${depth})`, 5);
            }
          }
        }

        // Resolve callback aliases through preceding map/filter stages, so a
        // predicate on `profile.active` after map(item => item.profile) is
        // attributed to the original input path `input.items[0].profile.active`.
        const callback = (ARRAY_CALLBACK_METHODS.has(method) || ARRAY_REDUCE_METHODS.has(method))
          ? node.arguments.find(isFunctionLikeCallback)
          : null;
        if (callback) {
          let currentAlias = { kind: 'path', path: [...receiverPath, '0'] };
          const callbackAliases = new Map(aliases);
          for (const stage of receiverModel?.stages ?? []) {
            if (stage.method === 'flat') {
              for (let level = 0; level < stage.depth; level += 1) {
                if (currentAlias?.kind === 'path') {
                  recordPath(currentAlias.path, 'array', 'medium', `Nested array inferred before flat() stage`, 5);
                  currentAlias = { kind: 'path', path: [...currentAlias.path, '0'] };
                } else currentAlias = { kind: 'unknown' };
              }
              continue;
            }
            if (ARRAY_COMPARATOR_METHODS.has(stage.method)) {
              if (stage.callback) {
                const [leftParameter, rightParameter, arrayParameter] = stage.callback.parameters;
                const comparatorAliases = new Map(callbackAliases);
                if (leftParameter && ts.isIdentifier(leftParameter.name)) comparatorAliases.set(leftParameter.name.text, currentAlias);
                if (rightParameter && ts.isIdentifier(rightParameter.name)) {
                  comparatorAliases.set(rightParameter.name.text, currentAlias?.kind === 'path'
                    ? { kind: 'path', path: [...currentAlias.path.slice(0, -1), '1'] }
                    : { kind: 'unknown' });
                }
                if (arrayParameter && ts.isIdentifier(arrayParameter.name)) comparatorAliases.set(arrayParameter.name.text, { kind: 'path', path: receiverPath });
                visit(stage.callback.body, comparatorAliases);
              }
              continue;
            }
            const [stageItem, stageIndex] = stage.callback?.parameters ?? [];
            if (stageItem && ts.isIdentifier(stageItem.name)) callbackAliases.set(stageItem.name.text, currentAlias);
            if (stageIndex && ts.isIdentifier(stageIndex.name)) callbackAliases.set(stageIndex.name.text, { kind: 'constant', value: 0 });
            if (stage.method === 'map' || stage.method === 'flatMap') recordArithmeticOperandPaths(stage.callback.body, callbackAliases);
            if (stage.method === 'filter') {
              const predicate = getCallbackPredicateExpression(stage.callback);
              if (predicate) recordCondition(predicate, callbackAliases);
              visit(stage.callback.body, callbackAliases);
            } else if (stage.method === 'map') {
              visit(stage.callback.body, callbackAliases);
              currentAlias = deriveMappedItemAlias(stage.callback, currentAlias, callbackAliases) ?? { kind: 'unknown' };
            } else if (stage.method === 'flatMap') {
              visit(stage.callback.body, callbackAliases);
              const mappedAlias = deriveMappedItemAlias(stage.callback, currentAlias, callbackAliases);
              if (mappedAlias?.kind === 'path') {
                recordPath(mappedAlias.path, 'array', 'medium', 'Returned as an array from flatMap() callback', 4);
                currentAlias = { kind: 'path', path: [...mappedAlias.path, '0'] };
              } else {
                currentAlias = { kind: 'unknown' };
              }
            } else if (stage.method === 'reduce') {
              currentAlias = { kind: 'unknown' };
            }
          }

          const callbackAliasesForCurrent = new Map(callbackAliases);
          if (ARRAY_REDUCE_METHODS.has(method)) {
            const accumulatorParameter = callback.parameters?.[0];
            const itemParameter = callback.parameters?.[1];
            const indexParameter = callback.parameters?.[2];
            const hasInitialValue = node.arguments.length > 1;
            const initialValue = hasInitialValue ? getLiteral(node.arguments[1]) : { ok: false };
            const evaluatedInitial = hasInitialValue ? evaluateReduceExpression(node.arguments[1], new Map()) : { ok: false };
            const initialPath = hasInitialValue ? getPathWithAliases(node.arguments[1], aliases) : null;
            const accumulatorAlias = initialValue.ok
              ? { kind: 'constant', value: initialValue.value }
              : evaluatedInitial.ok ? { kind: 'constant', value: evaluatedInitial.value }
                : initialPath ? { kind: 'path', path: initialPath }
                  : { kind: 'path', path: [...receiverPath, '0'] };
            if (accumulatorParameter && ts.isIdentifier(accumulatorParameter.name)) callbackAliasesForCurrent.set(accumulatorParameter.name.text, accumulatorAlias);
            if (itemParameter && ts.isIdentifier(itemParameter.name)) {
              const itemAlias = currentAlias?.kind === 'path'
                ? { kind: 'path', path: [...currentAlias.path.slice(0, -1), hasInitialValue ? '0' : '1'] }
                : { kind: 'path', path: [...receiverPath, hasInitialValue ? '0' : '1'] };
              callbackAliasesForCurrent.set(itemParameter.name.text, itemAlias);
            }
            recordArithmeticOperandPaths(callback.body, callbackAliasesForCurrent);
            if (indexParameter && ts.isIdentifier(indexParameter.name)) callbackAliasesForCurrent.set(indexParameter.name.text, { kind: 'constant', value: hasInitialValue ? 0 : 1 });
          } else if (ARRAY_COMPARATOR_METHODS.has(method)) {
            const [leftParameter, rightParameter, arrayParameter] = callback.parameters ?? [];
            if (leftParameter && ts.isIdentifier(leftParameter.name)) callbackAliasesForCurrent.set(leftParameter.name.text, { kind: 'path', path: [...receiverPath, '0'] });
            if (rightParameter && ts.isIdentifier(rightParameter.name)) callbackAliasesForCurrent.set(rightParameter.name.text, { kind: 'path', path: [...receiverPath, '1'] });
            if (arrayParameter && ts.isIdentifier(arrayParameter.name)) callbackAliasesForCurrent.set(arrayParameter.name.text, { kind: 'path', path: receiverPath });
          } else {
            const itemParameter = callback.parameters?.[0];
            const indexParameter = callback.parameters?.[1];
            if (itemParameter && ts.isIdentifier(itemParameter.name)) callbackAliasesForCurrent.set(itemParameter.name.text, currentAlias);
            if (indexParameter && ts.isIdentifier(indexParameter.name)) callbackAliasesForCurrent.set(indexParameter.name.text, { kind: 'constant', value: 0 });
          }
          if (ARRAY_PREDICATE_METHODS.has(method)) {
            const predicate = getCallbackPredicateExpression(callback);
            if (predicate) recordCondition(predicate, callbackAliasesForCurrent);
          }
          visit(callback.body, callbackAliasesForCurrent);
          for (const argument of node.arguments) if (argument !== callback) visit(argument, aliases);
          return;
        }
      }
    }
    if (ts.isIfStatement(node)) recordCondition(node.expression, aliases);
    else if (ts.isConditionalExpression(node)) recordCondition(node.condition, aliases);
    else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) recordCondition(node.expression, aliases);
    else if (ts.isSwitchStatement(node)) {
      const pathParts = getPathWithAliases(node.expression, aliases);
      if (pathParts && parameterSet.has(pathParts[0])) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) {
            const literal = getLiteral(clause.expression);
            if (literal.ok && typeof literal.value === 'string') recordPath(pathParts, 'string', 'high', `Used in switch with string case ${JSON.stringify(literal.value)}`, 4);
            else if (literal.ok && typeof literal.value === 'number') recordPath(pathParts, 'number', 'high', `Used in switch with numeric case ${literal.value}`, 4);
            else if (literal.ok && typeof literal.value === 'boolean') recordPath(pathParts, 'boolean', 'high', `Used in switch with boolean case ${literal.value}`, 4);
          }
        }
      }
    }

    // Collect property shapes through loop-local aliases as well as direct parameter paths.
    if (ts.isPropertyAccessExpression(node)) {
      const pathParts = getPathWithAliases(node, aliases);
      if (pathParts && parameterSet.has(pathParts[0]) && pathParts.length > 1) {
        const propertyName = node.name.text;
        if (!STRING_METHODS.has(propertyName) && !ARRAY_METHODS.has(propertyName) && propertyName !== 'length') {
          recordPath(pathParts, 'unknown', 'low', 'Property is accessed but no primitive type constraint was found', 0);
        }
      }
    } else if (ts.isElementAccessExpression(node)) {
      const pathParts = getPathWithAliases(node, aliases);
      if (pathParts && parameterSet.has(pathParts[0]) && pathParts.length > 1) {
        recordPath(pathParts, 'unknown', 'low', 'Indexed property is accessed but its value type is unknown', 0);
      }
    }
    ts.forEachChild(node, child => visit(child, aliases));
  }
  if (fn.body) visit(fn.body, new Map(initialAliases));

  // Containers inferred from descendants take precedence over a truthiness heuristic on the container itself.
  for (const [key, item] of [...inferred.entries()]) {
    if (item.kind !== 'unknown') continue;
    const hasDescendant = [...inferred.keys()].some(other => other.startsWith(`${key}.`));
    if (hasDescendant) set(item.path.split('.'), 'object', 'medium', 'Contains nested properties', 5);
  }
  return inferred;
}

function buildInferredValue(pathParts, inferredPaths) {
  const root = { kind: 'object', children: new Map() };
  const canonicalPath = pathParts.map((part, index) => index > 0 && /^\d+$/.test(part) ? '0' : part);
  const relevant = [...inferredPaths.values()].filter(item => {
    const parts = item.path.split('.');
    return parts[0] === canonicalPath[0] && parts.length > canonicalPath.length &&
      canonicalPath.every((part, index) => parts[index] === part);
  });

  for (const item of relevant) {
    const parts = item.path.split('.').slice(canonicalPath.length);
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const numeric = /^\d+$/.test(part);
      if (numeric) cursor.kind = 'array';
      else if (index < parts.length - 1 && cursor.kind !== 'array') cursor.kind = 'object';
      if (!cursor.children.has(part)) cursor.children.set(part, { kind: 'unknown', children: new Map() });
      cursor = cursor.children.get(part);
    }
    if (cursor.kind === 'unknown' || item.priority >= 2) cursor.kind = item.kind;
  }

  function materialize(node, depth = 0) {
    if (depth > MAX_DEPTH + 3) return undefined;
    if (node.kind === 'boolean') return false;
    if (node.kind === 'number') return 1;
    if (node.kind === 'string') return 'test';
    if (node.kind === 'array' || node.kind === 'sequence') {
      const numericChildren = [...node.children.entries()].filter(([key]) => /^\d+$/.test(key));
      if (!numericChildren.length) return [];
      const maxIndex = Math.min(7, Math.max(...numericChildren.map(([key]) => Number(key))));
      const array = Array.from({ length: maxIndex + 1 }, () => null);
      for (const [key, child] of numericChildren) {
        const value = materialize(child, depth + 1);
        if (value !== undefined) array[Number(key)] = value;
      }
      return array;
    }
    if (node.kind === 'object' || node.children.size) {
      const output = {};
      for (const [key, child] of node.children) {
        const value = materialize(child, depth + 1);
        if (value !== undefined) output[key] = value;
      }
      return output;
    }
    return undefined;
  }

  const value = materialize(root);
  return value && Object.keys(value).length ? value : {};
}

function inferredDefaultForPath(pathParts, inferredPaths) {
  const exact = inferredInfoForPath(pathParts, inferredPaths);
  if (!exact) {
    const nested = buildInferredValue(pathParts, inferredPaths);
    return nested && Object.keys(nested).length ? nested : undefined;
  }
  if (exact.kind === 'boolean') return false;
  if (exact.kind === 'number') return 1;
  if (exact.kind === 'string') return 'test';
  if (exact.kind === 'array' || exact.kind === 'sequence') return buildInferredValue(pathParts, inferredPaths);
  if (exact.kind === 'object') return buildInferredValue(pathParts, inferredPaths);
  return undefined;
}

function inferredInfoForPath(pathParts, inferredPaths) {
  if (!inferredPaths) return null;
  const exact = inferredPaths.get(pathParts.join('.'));
  if (exact) return exact;
  // Array element shapes are homogeneous for the generator's representative
  // model: infer items[1].field from evidence gathered at items[0].field.
  const canonical = pathParts.map((part, index) => index > 0 && /^\d+$/.test(part) ? '0' : part).join('.');
  return inferredPaths.get(canonical) ?? null;
}

  return Object.freeze({ inferPropertyModel, buildInferredValue, inferredDefaultForPath, inferredInfoForPath });
}
