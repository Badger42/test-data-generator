/**
 * TypeScript compiler adapter for type lookup, classification and value synthesis.
 * Compiler Type/Symbol objects remain inside this adapter boundary.
 */
export function createTypeModelProvider(ts, options = {}) {
  if (!ts) throw new TypeError('TypeModelProvider requires an injected TypeScript API.');
  const maxDepth = Number.isInteger(options.maxDepth) ? Math.max(0, options.maxDepth) : 4;

  function typeHasFlag(type, flag) {
    return Boolean(type && (type.flags & flag));
  }

  function unionMembers(type) {
    return type?.isUnion?.() ? type.types : [type];
  }

  function nonNullishType(type) {
    if (!type) return type;
    const members = unionMembers(type).filter(member => !typeHasFlag(member, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    if (members.length === 0) return type;
    // Preserve multi-member unions (notably boolean = true | false).
    return members.length === 1 ? members[0] : type;
  }

  function hasTypeFlagInUnion(type, flag) {
    return unionMembers(type).some(member => typeHasFlag(member, flag));
  }

  function isOptionalSymbol(symbol) {
    return Boolean(symbol?.flags & ts.SymbolFlags.Optional);
  }

  function literalForType(type) {
    if (type?.value !== undefined && (typeof type.value === 'string' || typeof type.value === 'number')) return type.value;
    if (typeHasFlag(type, ts.TypeFlags.BooleanLiteral)) return type.intrinsicName === 'true';
    return undefined;
  }

  function defaultValueForType(type, checker, location, depth = 0, seen = new Set()) {
    if (!type || depth > maxDepth) return null;
    const members = unionMembers(type);
    if (members.length > 1) {
      const preferred = members.find(member => !typeHasFlag(member, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) ?? members[0];
      return defaultValueForType(preferred, checker, location, depth + 1, seen);
    }
    const literal = literalForType(type);
    if (literal !== undefined) return literal;
    if (typeHasFlag(type, ts.TypeFlags.StringLike)) return 'test';
    if (typeHasFlag(type, ts.TypeFlags.NumberLike)) return 1;
    if (typeHasFlag(type, ts.TypeFlags.BooleanLike)) return false;
    if (typeHasFlag(type, ts.TypeFlags.BigIntLike)) return '1';
    if (typeHasFlag(type, ts.TypeFlags.Null)) return null;
    if (typeHasFlag(type, ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { $undefined: true };
    if (type.symbol?.name === 'Date') return '2026-01-01T00:00:00.000Z';
    if (checker.isArrayType(type)) return [];
    if (checker.isTupleType(type)) {
      return checker.getTypeArguments(type).map(member => defaultValueForType(member, checker, location, depth + 1, seen));
    }
    if (type.flags & ts.TypeFlags.EnumLike) {
      return literalForType(unionMembers(type)[0]) ?? 0;
    }
    if (type.flags & ts.TypeFlags.Object) {
      const symbol = type.getSymbol();
      const identity = symbol?.getName() ?? checker.typeToString(type);
      if (seen.has(identity)) return {};
      const nextSeen = new Set(seen);
      nextSeen.add(identity);
      const output = {};
      for (const property of checker.getPropertiesOfType(type)) {
        if (isOptionalSymbol(property)) continue;
        const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
        if (declaration && (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isGetAccessor(declaration) || ts.isSetAccessor(declaration))) continue;
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration ?? location);
        output[property.getName()] = defaultValueForType(propertyType, checker, declaration ?? location, depth + 1, nextSeen);
      }
      return output;
    }
    return null;
  }

  function getTypeAtPath(pathParts, parameterMap, localMockMap, checker, location) {
    if (!pathParts?.length) return null;
    let type = parameterMap.get(pathParts[0])?.type ?? localMockMap.get(pathParts[0])?.resolvedType;
    if (!type) return null;
    if (pathParts.length === 1) return type;
    type = nonNullishType(type);
    for (const part of pathParts.slice(1)) {
      type = nonNullishType(type);
      if (part === 'length') {
        if (checker.isArrayType(type) || checker.isTupleType(type) || typeHasFlag(type, ts.TypeFlags.StringLike)) return null;
      }
      const property = checker.getPropertiesOfType(type).find(item => item.getName() === part);
      if (!property) return null;
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
      type = checker.getTypeOfSymbolAtLocation(property, declaration ?? location);
    }
    return type;
  }

  function classifyType(type, checker) {
    if (!type || typeHasFlag(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    const members = unionMembers(type).filter(member => !typeHasFlag(member, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    if (!members.length) return null;
    const kinds = new Set(members.map(member => {
      if (typeHasFlag(member, ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) return 'boolean';
      if (typeHasFlag(member, ts.TypeFlags.NumberLike)) return 'number';
      if (typeHasFlag(member, ts.TypeFlags.StringLike)) return 'string';
      if (checker.isArrayType(member) || checker.isTupleType(member)) return 'array';
      if (member.flags & ts.TypeFlags.Object) return 'object';
      return 'unknown';
    }));
    return kinds.size === 1 && !kinds.has('unknown') ? [...kinds][0] : null;
  }

  function getType(pathParts, functionContext) {
    return getTypeAtPath(pathParts, functionContext.parameterMap, functionContext.localMockMap, functionContext.checker, functionContext.location);
  }

  function getDefaultValue(pathParts, functionContext) {
    const type = getType(pathParts, functionContext);
    return type ? defaultValueForType(type, functionContext.checker, functionContext.location) : undefined;
  }

  function classify(pathParts, functionContext) {
    const type = getType(pathParts, functionContext);
    return type ? classifyType(type, functionContext.checker) : null;
  }

  return Object.freeze({
    getType, getDefaultValue, classify,
    typeHasFlag, unionMembers, nonNullishType, hasTypeFlagInUnion,
    isOptionalSymbol, literalForType, defaultValueForType,
    getTypeAtPath, classifyType,
  });
}
