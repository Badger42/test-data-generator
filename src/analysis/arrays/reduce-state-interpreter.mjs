/**
 * Bounded concrete interpreter for reduce callback prefixes. It deliberately
 * supports only a conservative subset and never fabricates accumulator state
 * when a prior callback cannot be interpreted.
 */
export function createReduceStateInterpreter(ports) {
  const {
    ts, unwrap, getLiteral, undefinedMarker, getPathWithAliases,
    cloneJson, setNestedValue, getInputPathValue,
  } = ports;

  function evaluateExpression(node, environment) {
    const current = unwrap(node);
    if (!current) return { ok: false };
    const literal = getLiteral(current);
    if (literal.ok) return { ok: true, value: literal.value === undefinedMarker ? undefined : literal.value };
    if (ts.isIdentifier(current)) {
      if (environment.has(current.text)) return { ok: true, value: environment.get(current.text) };
      if (current.text === 'undefined') return { ok: true, value: undefined };
      return { ok: false };
    }
    if (ts.isPropertyAccessExpression(current)) {
      const base = evaluateExpression(current.expression, environment);
      return base.ok ? { ok: true, value: base.value == null ? undefined : base.value[current.name.text] } : { ok: false };
    }
    if (ts.isElementAccessExpression(current)) {
      const base = evaluateExpression(current.expression, environment);
      const key = evaluateExpression(current.argumentExpression, environment);
      return base.ok && key.ok ? { ok: true, value: base.value == null ? undefined : base.value[key.value] } : { ok: false };
    }
    if (ts.isPrefixUnaryExpression(current)) {
      const value = evaluateExpression(current.operand, environment);
      if (!value.ok) return value;
      if (current.operator === ts.SyntaxKind.ExclamationToken) return { ok: true, value: !value.value };
      if (current.operator === ts.SyntaxKind.MinusToken) return { ok: true, value: -value.value };
      if (current.operator === ts.SyntaxKind.PlusToken) return { ok: true, value: +value.value };
      return { ok: false };
    }
    if (ts.isConditionalExpression(current)) {
      const condition = evaluateExpression(current.condition, environment);
      return condition.ok
        ? evaluateExpression(condition.value ? current.whenTrue : current.whenFalse, environment)
        : { ok: false };
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      const left = evaluateExpression(current.left, environment);
      if (!left.ok) return left;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken && !left.value) return { ok: true, value: left.value };
      if (operator === ts.SyntaxKind.BarBarToken && left.value) return { ok: true, value: left.value };
      const right = evaluateExpression(current.right, environment);
      if (!right.ok) return right;
      switch (operator) {
        case ts.SyntaxKind.PlusToken: return { ok: true, value: left.value + right.value };
        case ts.SyntaxKind.MinusToken: return { ok: true, value: left.value - right.value };
        case ts.SyntaxKind.AsteriskToken: return { ok: true, value: left.value * right.value };
        case ts.SyntaxKind.SlashToken: return { ok: true, value: left.value / right.value };
        case ts.SyntaxKind.PercentToken: return { ok: true, value: left.value % right.value };
        case ts.SyntaxKind.AmpersandAmpersandToken: return { ok: true, value: left.value && right.value };
        case ts.SyntaxKind.BarBarToken: return { ok: true, value: left.value || right.value };
        case ts.SyntaxKind.QuestionQuestionToken: return { ok: true, value: left.value ?? right.value };
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return { ok: true, value: left.value === right.value };
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return { ok: true, value: left.value !== right.value };
        case ts.SyntaxKind.EqualsEqualsToken: return { ok: true, value: left.value == right.value };
        case ts.SyntaxKind.ExclamationEqualsToken: return { ok: true, value: left.value != right.value };
        case ts.SyntaxKind.LessThanToken: return { ok: true, value: left.value < right.value };
        case ts.SyntaxKind.LessThanEqualsToken: return { ok: true, value: left.value <= right.value };
        case ts.SyntaxKind.GreaterThanToken: return { ok: true, value: left.value > right.value };
        case ts.SyntaxKind.GreaterThanEqualsToken: return { ok: true, value: left.value >= right.value };
        default: return { ok: false };
      }
    }
    if (ts.isObjectLiteralExpression(current)) {
      const output = {};
      for (const property of current.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = evaluateExpression(property.expression, environment);
          if (!spread.ok || !spread.value || typeof spread.value !== 'object') return { ok: false };
          Object.assign(output, spread.value);
        } else if (ts.isPropertyAssignment(property)) {
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
            ? property.name.text : null;
          const value = evaluateExpression(property.initializer, environment);
          if (key === null || !value.ok) return { ok: false };
          output[key] = value.value;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          const value = evaluateExpression(property.name, environment);
          if (!value.ok) return { ok: false };
          output[property.name.text] = value.value;
        } else return { ok: false };
      }
      return { ok: true, value: output };
    }
    if (ts.isArrayLiteralExpression(current)) {
      const output = [];
      for (const element of current.elements) {
        const value = evaluateExpression(element, environment);
        if (!value.ok) return { ok: false };
        output.push(value.value);
      }
      return { ok: true, value: output };
    }
    return { ok: false };
  }

  function executeStatement(statement, environment) {
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) {
        const result = executeStatement(child, environment);
        if (result.returned || !result.ok) return result;
      }
      return { ok: true, returned: false };
    }
    if (ts.isIfStatement(statement)) {
      const condition = evaluateExpression(statement.expression, environment);
      if (!condition.ok) return { ok: false, returned: false };
      const selected = condition.value ? statement.thenStatement : statement.elseStatement;
      return selected ? executeStatement(selected, environment) : { ok: true, returned: false };
    }
    if (ts.isReturnStatement(statement)) {
      if (!statement.expression) return { ok: true, returned: true, value: undefined };
      const value = evaluateExpression(statement.expression, environment);
      return { ...value, returned: true };
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const value = evaluateExpression(declaration.initializer, environment);
        if (!value.ok) return { ok: false, returned: false };
        environment.set(declaration.name.text, value.value);
      }
      return { ok: true, returned: false };
    }
    if (ts.isExpressionStatement(statement)) {
      const expression = unwrap(statement.expression);
      if (ts.isBinaryExpression(expression) && [
        ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
      ].includes(expression.operatorToken.kind)) {
        const right = evaluateExpression(expression.right, environment);
        if (!right.ok) return { ok: false, returned: false };
        if (ts.isIdentifier(expression.left)) {
          const old = environment.get(expression.left.text);
          const value = expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? old + right.value
            : expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ? old - right.value : right.value;
          environment.set(expression.left.text, value);
          return { ok: true, returned: false };
        }
        if (ts.isPropertyAccessExpression(expression.left)) {
          const base = evaluateExpression(expression.left.expression, environment);
          if (!base.ok || !base.value || typeof base.value !== 'object') return { ok: false, returned: false };
          const key = expression.left.name.text;
          const old = base.value[key];
          base.value[key] = expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? old + right.value
            : expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ? old - right.value : right.value;
          return { ok: true, returned: false };
        }
        return { ok: false, returned: false };
      }
      const value = evaluateExpression(expression, environment);
      return { ok: value.ok, returned: false };
    }
    return { ok: false, returned: false };
  }

  function evaluateCallback(descriptor, accumulator, item, index) {
    const environment = new Map();
    const [accumulatorParameter, itemParameter, indexParameter] = descriptor.callback.parameters;
    if (accumulatorParameter && ts.isIdentifier(accumulatorParameter.name)) environment.set(accumulatorParameter.name.text, cloneJson(accumulator));
    if (itemParameter && ts.isIdentifier(itemParameter.name)) environment.set(itemParameter.name.text, cloneJson(item));
    if (indexParameter && ts.isIdentifier(indexParameter.name)) environment.set(indexParameter.name.text, index);
    if (!ts.isBlock(descriptor.callback.body)) return evaluateExpression(descriptor.callback.body, environment);
    const result = executeStatement(descriptor.callback.body, environment);
    if (result.returned) return result.ok ? { ok: true, value: result.value } : { ok: false };
    return { ok: true, value: undefined };
  }

  function createItemCandidates(collectionPath, baseItem, ctx) {
    const candidates = [cloneJson(baseItem)];
    if (typeof baseItem === 'number') return [0, 1, 6, 11];
    if (typeof baseItem === 'boolean') return [false, true];
    if (typeof baseItem === 'string') return ['', 'test'];
    const prefix = [...collectionPath, '0'].join('.') + '.';
    for (const inferred of ctx.inferredPaths.values()) {
      if (!inferred.path.startsWith(prefix)) continue;
      const relative = inferred.path.slice(prefix.length).split('.');
      let values = [];
      if (inferred.kind === 'number') values = [0, 1, 6, 11];
      else if (inferred.kind === 'boolean') values = [false, true];
      else if (inferred.kind === 'string') values = ['', 'test'];
      for (const value of values) {
        const candidate = cloneJson(baseItem);
        if (candidate && typeof candidate === 'object') setNestedValue(candidate, relative, value);
        else continue;
        candidates.push(candidate);
      }
    }
    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate);
      if (!seen.has(key)) { seen.add(key); unique.push(candidate); }
    }
    return unique.slice(0, 12);
  }

  function getAccumulatorAlias(descriptor, ctx) {
    if (!descriptor.hasInitialValue) return { kind: 'path', path: [...descriptor.collectionPath, '0'] };
    const literal = getLiteral(descriptor.initialValue);
    if (literal.ok) return { kind: 'constant', value: literal.value };
    const evaluated = evaluateExpression(descriptor.initialValue, new Map());
    if (evaluated.ok) return { kind: 'constant', value: evaluated.value };
    const initialPath = getPathWithAliases(descriptor.initialValue, ctx.pathAliases);
    if (initialPath) return { kind: 'path', path: initialPath };
    return null;
  }

  function getIterationSpecs(descriptor, iterationIndex, itemValue, ctx) {
    const collectionPath = descriptor.collectionPath;
    const arrayLength = iterationIndex + 1;
    const baseItems = Array.from({ length: arrayLength }, () => cloneJson(itemValue));
    const firstCallbackIndex = descriptor.hasInitialValue ? 0 : 1;
    if (iterationIndex <= firstCallbackIndex) {
      return [{ arrayValue: baseItems, accumulatorAlias: getAccumulatorAlias(descriptor, ctx), stateKey: `initial-${iterationIndex}` }];
    }

    const candidates = createItemCandidates(collectionPath, itemValue, ctx);
    const priorCallCount = iterationIndex - firstCallbackIndex;
    const accumulatorSeeds = descriptor.hasInitialValue
      ? (() => {
          const literal = getLiteral(descriptor.initialValue);
          if (literal.ok) return [{ value: literal.value === undefinedMarker ? undefined : literal.value, seedItem: null }];
          const evaluatedInitial = evaluateExpression(descriptor.initialValue, new Map());
          if (evaluatedInitial.ok) return [{ value: evaluatedInitial.value, seedItem: null }];
          const path = getPathWithAliases(descriptor.initialValue, ctx.pathAliases);
          if (path) return [{ value: getInputPathValue(path, ctx), seedItem: null }];
          return [];
        })()
      : candidates.map(seedItem => ({ value: cloneJson(seedItem), seedItem }));

    const specs = [];
    const seen = new Set();
    const maxStates = 16;
    for (const seed of accumulatorSeeds) {
      const priorSequences = [];
      const buildSequences = (prefix, remaining) => {
        if (priorSequences.length >= maxStates * 4) return;
        if (remaining === 0) { priorSequences.push(prefix); return; }
        for (const candidate of candidates) {
          buildSequences([...prefix, candidate], remaining - 1);
          if (priorSequences.length >= maxStates * 4) break;
        }
      };
      buildSequences([], priorCallCount);
      for (const priorItems of priorSequences) {
        let accumulator = cloneJson(seed.value);
        let supported = true;
        for (let offset = 0; offset < priorItems.length; offset += 1) {
          const callbackIndex = firstCallbackIndex + offset;
          const evaluated = evaluateCallback(descriptor, accumulator, priorItems[offset], callbackIndex);
          if (!evaluated.ok || evaluated.value === undefined || evaluated.value === null ||
              (!['number', 'string', 'boolean'].includes(typeof evaluated.value) && typeof evaluated.value !== 'object')) {
            supported = false;
            break;
          }
          accumulator = cloneJson(evaluated.value);
        }
        if (!supported) continue;
        const items = Array.from({ length: arrayLength }, () => cloneJson(itemValue));
        if (!descriptor.hasInitialValue) items[0] = cloneJson(seed.seedItem);
        for (let offset = 0; offset < priorItems.length; offset += 1) {
          items[firstCallbackIndex + offset] = cloneJson(priorItems[offset]);
        }
        const stateFingerprint = JSON.stringify([items.slice(0, iterationIndex), accumulator]);
        if (seen.has(stateFingerprint)) continue;
        seen.add(stateFingerprint);
        specs.push({
          arrayValue: items,
          accumulatorAlias: { kind: 'constant', value: cloneJson(accumulator) },
          stateKey: `after-${priorCallCount}-calls-${JSON.stringify(accumulator)}-${specs.length}`,
        });
        if (specs.length >= maxStates) break;
      }
      if (specs.length >= maxStates) break;
    }
    return specs;
  }

  return Object.freeze({
    evaluateExpression,
    evaluateCallback,
    createItemCandidates,
    getIterationSpecs,
    getAccumulatorAlias,
  });
}
