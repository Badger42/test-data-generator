import { getIdentifierSymbol, getStableSymbolId, getSourceSpan, isNestedFunction, unwrapExpression } from '../ast-utils.mjs';

function isFunctionLike(node, ts) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration?.(node);
}

function rootIdentifier(node, ts) {
  let current = unwrapExpression(node, ts);
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) current = current.expression;
  return current && ts.isIdentifier(current) ? current : null;
}

function staticMember(node, ts) {
  const current = unwrapExpression(node, ts);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const argument = unwrapExpression(current.argumentExpression, ts);
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (ts.isNumericLiteral(argument)) return String(Number(argument.text));
  }
  return '*';
}

/**
 * Bounded Andersen-style intraprocedural points-to analysis.
 * It models allocation sites, reference copies and field loads/stores. Unknown
 * calls are intentionally not assigned fabricated allocation sites.
 */
export function analyzePointsTo(functionNode, ts, checker, sourceFile, options = {}) {
  const relativeFile = options.relativeFile ?? sourceFile?.fileName;
  const allocations = new Map();
  const pointsTo = new Map();
  const symbolNames = new Map();
  const heapFields = new Map();
  const copyConstraints = [];
  const loadConstraints = [];
  const storeConstraints = [];
  const diagnostics = [];
  // Flow-insensitive may-points-to sets are widened with an explicit top bit.
  // Never infer must-alias from a singleton set when an unknown assignment/store
  // may also reach the symbol or field.
  const unknown = new Set();
  const unknownHeapFields = new Set();

  const symbolId = node => {
    const root = rootIdentifier(node, ts) ?? (node && ts.isIdentifier(node) ? node : null);
    if (!root) return null;
    const info = getIdentifierSymbol(root, ts, checker);
    if (info) symbolNames.set(info.symbolId, info.name);
    return info?.symbolId ?? null;
  };
  const setFor = (map, key) => {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
  };
  const markUnknown = targetSymbolId => {
    if (!targetSymbolId || unknown.has(targetSymbolId)) return false;
    unknown.add(targetSymbolId);
    return true;
  };
  const markUnknownField = (siteId, member) => {
    if (!siteId || !member) return false;
    const key = fieldKey(siteId, member);
    if (unknownHeapFields.has(key)) return false;
    unknownHeapFields.add(key);
    return true;
  };
  const addTarget = (targetSymbolId, siteId) => {
    if (!targetSymbolId || !siteId) return false;
    const set = setFor(pointsTo, targetSymbolId);
    const before = set.size;
    set.add(siteId);
    return set.size !== before;
  };
  const fieldKey = (siteId, member) => `${siteId}::${member}`;
  const addFieldTarget = (siteId, member, targetSite) => {
    if (!siteId || !member || !targetSite) return false;
    const set = setFor(heapFields, fieldKey(siteId, member));
    const before = set.size;
    set.add(targetSite);
    return set.size !== before;
  };
  const allocate = (node, kind, label = '') => {
    const start = node.getStart(sourceFile);
    const id = `alloc:${options.functionId ?? 'function'}:${start}:${kind}${label ? `:${label}` : ''}`;
    if (!allocations.has(id)) allocations.set(id, {
      id, kind, sourceSpan: getSourceSpan(node, sourceFile, relativeFile),
      external: false,
    });
    return id;
  };
  const getExpressionReference = expression => {
    const current = unwrapExpression(expression, ts);
    if (!current) return { kind: 'unknown', reason: 'missing-expression' };
    if (ts.isIdentifier(current)) {
      const id = symbolId(current);
      return id ? { kind: 'symbol', symbolId: id } : { kind: 'unknown', reason: 'unresolved-symbol' };
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      const base = rootIdentifier(current, ts);
      const baseId = base ? symbolId(base) : null;
      if (!baseId) return { kind: 'unknown', reason: 'unresolved-member-base' };
      let memberPath = [];
      let cursor = current;
      while (ts.isPropertyAccessExpression(cursor) || ts.isElementAccessExpression(cursor)) {
        memberPath.unshift(staticMember(cursor, ts));
        cursor = cursor.expression;
      }
      return { kind: 'load', baseSymbolId: baseId, memberPath };
    }
    if (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current) || ts.isNewExpression(current) || isFunctionLike(current, ts)) {
      return { kind: 'allocation', siteId: allocate(current, ts.isArrayLiteralExpression(current) ? 'array' : ts.isObjectLiteralExpression(current) ? 'object' : ts.isNewExpression(current) ? 'instance' : 'closure') };
    }
    if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current) ||
        current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword ||
        current.kind === ts.SyntaxKind.NullKeyword || current.kind === ts.SyntaxKind.UndefinedKeyword) {
      return { kind: 'non-reference', reason: 'primitive-value' };
    }
    if (ts.isConditionalExpression(current)) return { kind: 'union', references: [getExpressionReference(current.whenTrue), getExpressionReference(current.whenFalse)] };
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return { kind: 'union', references: [getExpressionReference(current.left), getExpressionReference(current.right)] };
    }
    if (ts.isCallExpression(current) || ts.isAwaitExpression(current)) return { kind: 'unknown', reason: 'call-result-not-modeled' };
    return { kind: 'unknown', reason: 'unsupported-reference-expression' };
  };

  function seedObjectFields(node, siteId, depth = 0) {
    if (!node || depth > 8) return;
    const current = unwrapExpression(node, ts);
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))
            ? property.name.text : '*';
          seedFieldValue(siteId, String(name), property.initializer, depth + 1);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          // For `{ child }`, getSymbolAtLocation(child) is the synthetic
          // property symbol, not the value symbol of the shorthand binding.
          const valueSymbol = checker?.getShorthandAssignmentValueSymbol?.(property);
          const target = getStableSymbolId(valueSymbol, checker);
          if (target) {
            symbolNames.set(target, valueSymbol.getName?.() ?? property.name.text);
            storeConstraints.push({ kind: 'store-symbol', baseSiteId: siteId, member: property.name.text, sourceSymbolId: target });
          }
        } else if (ts.isSpreadAssignment(property)) {
          const sourceSymbolId = symbolId(property.expression);
          if (sourceSymbolId) storeConstraints.push({ kind: 'spread', baseSiteId: siteId, sourceSymbolId });
          diagnostics.push({ code: 'POINTS_TO_OBJECT_SPREAD_APPROXIMATED', severity: 'info', sourceSpan: getSourceSpan(property, sourceFile, relativeFile), message: 'Object spread is represented as a conservative wildcard field copy.' });
        }
      }
    } else if (ts.isArrayLiteralExpression(current)) {
      current.elements.forEach((element, index) => {
        if (ts.isSpreadElement(element)) {
          const sourceSymbolId = symbolId(element.expression);
          if (sourceSymbolId) storeConstraints.push({ kind: 'spread', baseSiteId: siteId, sourceSymbolId });
        } else seedFieldValue(siteId, String(index), element, depth + 1);
      });
    }
  }
  function seedFieldValue(baseSiteId, member, expression, depth) {
    const reference = getExpressionReference(expression);
    if (reference.kind === 'allocation') {
      addFieldTarget(baseSiteId, member, reference.siteId);
      seedObjectFields(expression, reference.siteId, depth + 1);
    } else if (reference.kind === 'symbol') {
      storeConstraints.push({ kind: 'store-symbol', baseSiteId, member, sourceSymbolId: reference.symbolId });
    } else if (reference.kind === 'load') {
      loadConstraints.push({ kind: 'load-field', targetField: fieldKey(baseSiteId, member), baseSymbolId: reference.baseSymbolId, memberPath: reference.memberPath });
    } else if (reference.kind === 'union') {
      for (const item of reference.references) {
        if (item.kind === 'allocation') addFieldTarget(baseSiteId, member, item.siteId);
        else if (item.kind === 'symbol') storeConstraints.push({ kind: 'store-symbol', baseSiteId, member, sourceSymbolId: item.symbolId });
        else if (item.kind === 'load') loadConstraints.push({ kind: 'load-field', targetField: fieldKey(baseSiteId, member), baseSymbolId: item.baseSymbolId, memberPath: item.memberPath });
        else if (item.kind === 'unknown' || item.kind === 'non-reference') markUnknownField(baseSiteId, member);
      }
    } else if (reference.kind === 'unknown') {
      markUnknownField(baseSiteId, member);
    }
  }

  // Parameters are modeled as distinct external regions. They are not assumed
  // disjoint: the summary records possible cross-parameter aliasing separately.
  for (const parameter of functionNode?.parameters ?? []) {
    if (!ts.isIdentifier(parameter.name)) continue;
    const id = symbolId(parameter.name);
    if (!id) continue;
    let parameterType = null;
    try { parameterType = checker?.getTypeAtLocation(parameter); } catch { /* unresolved types are not treated as references */ }
    const members = parameterType?.isUnion?.() ? parameterType.types : [parameterType];
    const isReferenceType = members.some(member => member && (
      Boolean(member.flags & ts.TypeFlags.Object) || checker?.isArrayType?.(member) || checker?.isTupleType?.(member)
    ));
    if (!isReferenceType) continue;
    const siteId = `external:${id}`;
    allocations.set(siteId, { id: siteId, kind: 'external-parameter', external: true, sourceSpan: getSourceSpan(parameter, sourceFile, relativeFile) });
    addTarget(id, siteId);
    unknown.add(id);
  }

  const visit = node => {
    if (!node) return;
    if (node !== functionNode && isNestedFunction(node, functionNode, ts)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const target = symbolId(node.name);
      const ref = getExpressionReference(node.initializer);
      if (target) {
        if (ref.kind === 'allocation') {
          addTarget(target, ref.siteId);
          seedObjectFields(node.initializer, ref.siteId);
        } else if (ref.kind === 'symbol') copyConstraints.push({ from: ref.symbolId, to: target, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
        else if (ref.kind === 'load') loadConstraints.push({ targetSymbolId: target, ...ref, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
        else if (ref.kind === 'union') {
          for (const item of ref.references) {
            if (item.kind === 'allocation') addTarget(target, item.siteId);
            else if (item.kind === 'symbol') copyConstraints.push({ from: item.symbolId, to: target, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
            else if (item.kind === 'load') loadConstraints.push({ targetSymbolId: target, ...item, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
            else if (item.kind === 'unknown' || item.kind === 'non-reference') markUnknown(target);
          }
        } else if (ref.kind === 'unknown') markUnknown(target);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left)) {
        const target = symbolId(node.left);
        const ref = getExpressionReference(node.right);
        if (target && ref.kind === 'allocation') { addTarget(target, ref.siteId); seedObjectFields(node.right, ref.siteId); }
        else if (target && ref.kind === 'symbol') copyConstraints.push({ from: ref.symbolId, to: target, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
        else if (target && ref.kind === 'load') loadConstraints.push({ targetSymbolId: target, ...ref, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
        else if (target && ref.kind === 'union') for (const item of ref.references) {
          if (item.kind === 'allocation') addTarget(target, item.siteId);
          else if (item.kind === 'symbol') copyConstraints.push({ from: item.symbolId, to: target, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
          else if (item.kind === 'load') loadConstraints.push({ targetSymbolId: target, ...item, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
          else if (item.kind === 'unknown' || item.kind === 'non-reference') markUnknown(target);
        }
        else if (target && (ref.kind === 'unknown' || ref.kind === 'non-reference')) markUnknown(target);
      } else if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
        const base = rootIdentifier(node.left, ts);
        const baseSymbolId = base ? symbolId(base) : null;
        const member = staticMember(node.left, ts);
        const ref = getExpressionReference(node.right);
        if (baseSymbolId) {
          if (ref.kind === 'allocation') {
            storeConstraints.push({ kind: 'store-site', baseSymbolId, member, siteId: ref.siteId, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
            seedObjectFields(node.right, ref.siteId);
          } else if (ref.kind === 'symbol') {
            storeConstraints.push({ kind: 'store-symbol', baseSymbolId, member, sourceSymbolId: ref.symbolId, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
          } else if (ref.kind === 'union') {
            for (const item of ref.references) {
              if (item.kind === 'allocation') storeConstraints.push({ kind: 'store-site', baseSymbolId, member, siteId: item.siteId, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
              else if (item.kind === 'symbol') storeConstraints.push({ kind: 'store-symbol', baseSymbolId, member, sourceSymbolId: item.symbolId, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
              else storeConstraints.push({ kind: 'store-unknown', baseSymbolId, member, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
            }
          } else {
            // Unknown calls, primitive overwrites and unsupported expressions all
            // widen the field. Retaining old targets is sound only with this top bit.
            storeConstraints.push({ kind: 'store-unknown', baseSymbolId, member, sourceSpan: getSourceSpan(node, sourceFile, relativeFile) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (functionNode?.body) visit(functionNode.body);

  let changed = true;
  let passes = 0;
  const maxPasses = Math.max(8, (copyConstraints.length + loadConstraints.length + storeConstraints.length + allocations.size + 1) * 4);
  while (changed && passes++ < maxPasses) {
    changed = false;
    for (const constraint of copyConstraints) {
      for (const siteId of pointsTo.get(constraint.from) ?? []) changed = addTarget(constraint.to, siteId) || changed;
      if (unknown.has(constraint.from)) changed = markUnknown(constraint.to) || changed;
    }
    for (const constraint of storeConstraints) {
      if (constraint.kind === 'store-site') {
        for (const siteId of pointsTo.get(constraint.baseSymbolId) ?? []) changed = addFieldTarget(siteId, constraint.member, constraint.siteId) || changed;
      } else if (constraint.kind === 'store-unknown') {
        for (const siteId of pointsTo.get(constraint.baseSymbolId) ?? []) changed = markUnknownField(siteId, constraint.member) || changed;
      } else if (constraint.kind === 'store-symbol') {
        for (const siteId of pointsTo.get(constraint.baseSymbolId ?? '') ?? (constraint.baseSiteId ? [constraint.baseSiteId] : [])) {
          for (const target of pointsTo.get(constraint.sourceSymbolId) ?? []) changed = addFieldTarget(siteId, constraint.member, target) || changed;
          if (unknown.has(constraint.sourceSymbolId)) changed = markUnknownField(siteId, constraint.member) || changed;
        }
      } else if (constraint.kind === 'spread') {
        if (unknown.has(constraint.sourceSymbolId)) changed = markUnknownField(constraint.baseSiteId, '*') || changed;
        for (const base of pointsTo.get(constraint.sourceSymbolId) ?? []) {
          for (const [key, values] of heapFields) if (key.startsWith(`${base}::`)) {
            const member = key.slice(`${base}::`.length);
            for (const target of values) changed = addFieldTarget(constraint.baseSiteId, member === '*' ? '*' : member, target) || changed;
            if (unknownHeapFields.has(key)) changed = markUnknownField(constraint.baseSiteId, member) || changed;
          }
          for (const key of unknownHeapFields) if (key.startsWith(`${base}::`)) {
            const member = key.slice(`${base}::`.length);
            changed = markUnknownField(constraint.baseSiteId, member) || changed;
          }
        }
      }
    }
    for (const constraint of loadConstraints) {
      let targets = new Set();
      let loadMayBeUnknown = unknown.has(constraint.baseSymbolId);
      for (const baseSite of pointsTo.get(constraint.baseSymbolId) ?? []) {
        let currentSites = new Set([baseSite]);
        for (const member of constraint.memberPath ?? []) {
          const nextSites = new Set();
          for (const site of currentSites) {
            if (unknownHeapFields.has(fieldKey(site, member)) || unknownHeapFields.has(fieldKey(site, '*'))) loadMayBeUnknown = true;
            for (const target of heapFields.get(fieldKey(site, member)) ?? []) nextSites.add(target);
            for (const target of heapFields.get(fieldKey(site, '*')) ?? []) nextSites.add(target);
          }
          currentSites = nextSites;
        }
        for (const site of currentSites) targets.add(site);
      }
      if (constraint.targetSymbolId && loadMayBeUnknown) changed = markUnknown(constraint.targetSymbolId) || changed;
      if (constraint.targetSymbolId) for (const target of targets) changed = addTarget(constraint.targetSymbolId, target) || changed;
      else if (constraint.targetField) for (const target of targets) {
        const [base, member] = constraint.targetField.split('::');
        changed = addFieldTarget(base, member, target) || changed;
      }
    }
  }
  if (changed) diagnostics.push({ code: 'POINTS_TO_FIXED_POINT_LIMIT', severity: 'warning', message: 'Points-to propagation reached its bounded iteration limit; results remain conservative.' });

  // External parameter regions may alias one another. We expose that as a
  // may-alias relation without merging their points-to sets or proving identity.
  const symbols = [...pointsTo.keys()].sort();
  const aliasPairs = [];
  for (let i = 0; i < symbols.length; i += 1) for (let j = i + 1; j < symbols.length; j += 1) {
    const left = symbols[i], right = symbols[j];
    const leftSites = pointsTo.get(left) ?? new Set();
    const rightSites = pointsTo.get(right) ?? new Set();
    const intersection = [...leftSites].filter(site => rightSites.has(site));
    const mayExternalOverlap = unknown.has(left) && unknown.has(right);
    if (!intersection.length && !mayExternalOverlap) continue;
    const must = intersection.length === 1 && leftSites.size === 1 && rightSites.size === 1 &&
      !unknown.has(left) && !unknown.has(right) && !allocations.get(intersection[0])?.external;
    aliasPairs.push({ leftSymbolId: left, rightSymbolId: right, relation: must ? 'must-alias' : 'may-alias',
      sharedAllocationSites: intersection.sort(), confidence: must ? 'high' : 'medium',
      reason: mayExternalOverlap && !intersection.length ? 'external-parameter-regions-may-overlap' : 'shared-points-to-target' });
  }
  const serialPointsTo = Object.fromEntries([...pointsTo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, sites]) => [id, [...sites].sort()]));
  const serialHeapFields = Object.fromEntries([...heapFields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, sites]) => [key, [...sites].sort()]));
  return Object.freeze({
    schemaVersion: '1.1', algorithm: 'bounded-andersen-inclusion-points-to',
    allocations: Object.freeze([...allocations.values()].sort((a, b) => a.id.localeCompare(b.id))),
    symbols: Object.freeze(Object.fromEntries([...symbolNames.entries()].sort(([a], [b]) => a.localeCompare(b)))),
    pointsTo: Object.freeze(serialPointsTo), heapFields: Object.freeze(serialHeapFields),
    unknownSymbols: Object.freeze([...unknown].sort()),
    unknownHeapFields: Object.freeze([...unknownHeapFields].sort()),
    aliasPairs: Object.freeze(aliasPairs),
    constraints: Object.freeze({ copies: copyConstraints.length, loads: loadConstraints.length, stores: storeConstraints.length }),
    convergence: Object.freeze({ converged: !changed, passes, maxPasses }),
    diagnostics: Object.freeze(diagnostics),
    limits: Object.freeze({ flowSensitivity: 'flow-insensitive-inclusion-constraints', contextSensitivity: 'intraprocedural', unknownCalls: 'not-assigned-fabricated-targets', externalParameters: 'distinct-regions-with-explicit-may-alias', heapFields: 'static-member-or-wildcard-with-top-widening' }),
  });
}
