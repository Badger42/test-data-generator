import path from 'node:path';

function isFunctionLike(node, ts) {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || (ts.isMethodDeclaration?.(node) && Boolean(node.body));
}

function declarationNameNode(node, ts) {
  if (node.name) return node.name;
  if (ts.isVariableDeclaration(node.parent)) return node.parent.name;
  if (ts.isPropertyAssignment(node.parent)) return node.parent.name;
  return null;
}

function resolveAliasedSymbol(symbol, checker, ts) {
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try { return checker.getAliasedSymbol(symbol); } catch { return symbol; }
  }
  return symbol;
}

function normalizedRelative(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

const BUILTIN_LIBRARY_OWNERS = new Set([
  'Array', 'ReadonlyArray', 'String', 'Number', 'Boolean', 'BigInt',
  'RegExp', 'Date', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet',
  'WeakMap', 'WeakSet', 'Promise', 'Object', 'Function',
  'ArrayConstructor', 'StringConstructor', 'NumberConstructor',
  'BooleanConstructor', 'BigIntConstructor', 'RegExpConstructor',
  'DateConstructor', 'PromiseConstructor', 'ObjectConstructor',
  'FunctionConstructor', 'Math', 'JSON', 'Symbol', 'SymbolConstructor',
]);

function isTypescriptStandardLibraryFile(filename) {
  return /(?:^|[\\/])node_modules[\\/]typescript[\\/]lib[\\/]lib\\..+\\.d\\.ts$/i.test(filename) ||
    /(?:^|[\\/])typescript[\\/]lib[\\/]lib\\..+\\.d\\.ts$/i.test(filename);
}

function isKnownBuiltinLibraryMember(symbol, filename, ts) {
  if (!isTypescriptStandardLibraryFile(filename)) return false;
  // The checker symbol's parent is not consistently populated for members
  // declared by standard-library interfaces. Resolve the owning AST declaration.
  for (const declaration of symbol?.declarations ?? []) {
    for (let current = declaration.parent; current && !ts.isSourceFile(current); current = current.parent) {
      const typeDeclaration = ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) || ts.isClassExpression(current);
      if (!typeDeclaration) continue;
      const owner = current.name?.text ?? '';
      if (BUILTIN_LIBRARY_OWNERS.has(owner)) return true;
      break;
    }
  }
  return false;
}


function hasExportModifierInAncestors(node, sourceFile, ts) {
  for (let current = node; current && current !== sourceFile; current = current.parent) {
    if (current.modifiers?.some(modifier =>
      modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true;
    if (ts.isExportAssignment(current)) return true;
  }
  return false;
}

function collectExportedFunctionNodes(sourceFile, checker, ts) {
  const exportedNodes = new WeakSet();
  const markDeclaration = declaration => {
    if (!declaration) return;
    if (isFunctionLike(declaration, ts)) {
      exportedNodes.add(declaration);
      return;
    }
    if ((ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration?.(declaration)) &&
        isFunctionLike(declaration.initializer, ts)) {
      exportedNodes.add(declaration.initializer);
      return;
    }
    if (ts.isVariableDeclaration(declaration) && isFunctionLike(declaration.initializer, ts)) {
      exportedNodes.add(declaration.initializer);
    }
  };

  if (!sourceFile.symbol) return exportedNodes;
  let exports = [];
  try { exports = checker.getExportsOfModule(sourceFile.symbol) ?? []; } catch { /* Not an external module. */ }
  for (const exportSymbol of exports) {
    const resolved = resolveAliasedSymbol(exportSymbol, checker, ts) ?? exportSymbol;
    for (const declaration of resolved.declarations ?? (resolved.valueDeclaration ? [resolved.valueDeclaration] : [])) {
      markDeclaration(declaration);
    }
    try {
      const declaration = exportSymbol.valueDeclaration ?? resolved.valueDeclaration ?? resolved.declarations?.[0];
      let type = null;
      if (declaration && ts.isExportAssignment(declaration)) {
        type = checker.getTypeAtLocation(declaration.expression);
      } else if (declaration) {
        type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
      }
      if (type) {
        for (const property of checker.getPropertiesOfType(type)) {
          for (const propertyDeclaration of property.declarations ?? []) markDeclaration(propertyDeclaration);
        }
      }
    } catch { /* Export type information supplements direct AST ancestry. */ }
  }
  return exportedNodes;
}

/**
 * Builds a project-scoped TypeScript function index. Symbol IDs include the
 * source module and declaration offset, so same-named declarations in
 * different files cannot collide. Imported/re-exported aliases resolve to the
 * original declaration symbol.
 */
export function buildProjectFunctionIndex(project) {
  const ts = project?.compilerApi;
  const checker = project?.checker;
  const program = project?.program;
  if (!ts || !checker || !program) throw new TypeError('ProjectFunctionIndex requires a TypeScript Program and TypeChecker.');

  const projectRoot = project.projectRoot ?? process.cwd();
  const getRelativeFileName = project.getRelativeFileName ?? (filename => normalizedRelative(projectRoot, filename));
  const entries = [];
  const bySymbolId = new Map();
  const bySymbol = new Map();
  const byNode = new WeakMap();
  const diagnostics = [];

  const symbolKey = symbol => {
    const resolved = resolveAliasedSymbol(symbol, checker, ts);
    if (!resolved) return null;
    const declarations = resolved.declarations ?? (resolved.valueDeclaration ? [resolved.valueDeclaration] : []);
    const declaration = resolved.valueDeclaration ?? declarations.find(item => item.body) ?? declarations[0];
    if (!declaration) return null;
    const sourceFile = declaration.getSourceFile?.();
    if (!sourceFile) return null;
    const nameNode = declaration.name ?? declaration;
    let offset = -1;
    try { offset = nameNode.getStart(sourceFile); } catch { try { offset = declaration.getStart(sourceFile); } catch { /* synthetic */ } }
    const relativeFile = getRelativeFileName(sourceFile.fileName);
    return `${relativeFile}#${offset}:${resolved.getName?.() ?? 'anonymous'}`;
  };

  const add = (node, sourceFile, exportedFunctionNodes) => {
    if (!isFunctionLike(node, ts)) return;
    const nameNode = declarationNameNode(node, ts);
    const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : null;
    const resolved = resolveAliasedSymbol(symbol, checker, ts);
    const symbolId = symbolKey(resolved);
    if (!symbolId) return;
    const relativeFile = getRelativeFileName(sourceFile.fileName);
    const startOffset = node.getStart(sourceFile);
    const name = nameNode?.text ?? nameNode?.getText?.(sourceFile) ?? resolved.getName?.() ?? 'anonymous';
    const functionId = `${relativeFile}::${name}@${startOffset}`;
    const existing = bySymbolId.get(symbolId);
    // Prefer an implementation body over an overload signature or declaration.
    if (existing) {
      if (!existing.node.body && node.body) {
        existing.node = node;
        existing.sourceFile = sourceFile;
        existing.functionId = functionId;
        existing.relativeFile = relativeFile;
      }
      byNode.set(node, existing);
      return;
    }
    const entry = {
      functionId, symbolId, name, node, sourceFile, relativeFile,
      startOffset, endOffset: node.end,
      exported: hasExportModifierInAncestors(node, sourceFile, ts) || exportedFunctionNodes.has(node),
    };
    entries.push(entry);
    bySymbolId.set(symbolId, entry);
    bySymbol.set(resolved, entry);
    byNode.set(node, entry);
  };

  const sourceFiles = program.getSourceFiles().filter(sourceFile => {
    if (sourceFile.isDeclarationFile) return false;
    const normalized = sourceFile.fileName.split(path.sep).join('/');
    return !normalized.includes('/node_modules/') && !normalized.includes('/typescript/lib/');
  });

  for (const sourceFile of sourceFiles) {
    const exportedFunctionNodes = collectExportedFunctionNodes(sourceFile, checker, ts);
    const visit = node => {
      if (isFunctionLike(node, ts)) add(node, sourceFile, exportedFunctionNodes);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  entries.sort((a, b) => a.relativeFile.localeCompare(b.relativeFile) || a.startOffset - b.startOffset || a.name.localeCompare(b.name));

  function resolveCall(callExpressionOrNode) {
    const expression = ts.isCallExpression(callExpressionOrNode) ? callExpressionOrNode.expression : callExpressionOrNode;
    let symbol = null;
    try { symbol = checker.getSymbolAtLocation(expression); } catch { /* unresolved call */ }
    const resolved = resolveAliasedSymbol(symbol, checker, ts);
    const entry = resolved ? bySymbol.get(resolved) ?? bySymbolId.get(symbolKey(resolved)) : null;
    return entry ?? null;
  }

  function classifyCall(callExpressionOrNode) {
    const expression = ts.isCallExpression(callExpressionOrNode) ? callExpressionOrNode.expression : callExpressionOrNode;
    const text = expression?.getText?.() ?? '';
    if (PURE_INTRINSICS.has(text)) return { kind: 'pure-intrinsic', confidence: 'high', call: text };
    // Explicit globalThis access denotes a host/runtime seam rather than a
    // project function. Such calls may be supplied by setup files and remain
    // mockable even though their declarations are not part of the TS Program.
    if (/^globalThis(?:\.|\[)/.test(text)) {
      return { kind: 'external-dependency', confidence: 'medium', source: 'global-runtime', symbolName: text };
    }
    const target = resolveCall(expression);
    if (target) return { kind: 'project-function', confidence: 'high', targetFunctionId: target.functionId, symbolId: target.symbolId };
    let symbol = null;
    try { symbol = checker.getSymbolAtLocation(expression); } catch { /* unresolved */ }
    const resolved = resolveAliasedSymbol(symbol, checker, ts);
    const declarations = resolved?.declarations ?? (resolved?.valueDeclaration ? [resolved.valueDeclaration] : []);
    const declarationFile = declarations[0]?.getSourceFile?.().fileName?.split(path.sep).join('/') ?? '';
    // TypeScript's own lib declarations live under node_modules/typescript,
    // so inspect known language builtins before the generic node_modules rule.
    // DOM host seams (fetch, Window, Navigator, timers, etc.) remain mockable.
    if (isKnownBuiltinLibraryMember(resolved, declarationFile, ts)) {
      return {
        kind: 'builtin-intrinsic',
        confidence: 'high',
        source: 'javascript-standard-library',
        symbolName: resolved?.getName?.() ?? text,
      };
    }
    if (declarationFile.includes('/node_modules/')) return { kind: 'external-dependency', confidence: 'high', symbolName: resolved?.getName?.() ?? text };
    const hasImplementation = declarations.some(declaration => Boolean(declaration.body));
    const contractOnly = declarations.length > 0 && declarations.every(declaration =>
      ts.isMethodSignature?.(declaration) || ts.isCallSignatureDeclaration?.(declaration) ||
      ts.isFunctionTypeNode?.(declaration) || (ts.isMethodDeclaration?.(declaration) && !declaration.body) ||
      (ts.isFunctionDeclaration?.(declaration) && !declaration.body));
    if (!hasImplementation && contractOnly) {
      return { kind: 'external-dependency', confidence: 'medium', source: 'type-contract', symbolName: resolved?.getName?.() ?? text };
    }
    if (resolved && declarations.length) return { kind: 'project-unindexed', confidence: 'low', symbolName: resolved.getName?.() ?? text };
    return { kind: 'unresolved', confidence: 'low', symbolName: text };
  }

  return Object.freeze({
    schemaVersion: '1.0',
    entries: Object.freeze(entries),
    size: entries.length,
    diagnostics: Object.freeze(diagnostics),
    getRelativeFileName,
    symbolIdForNode(node) {
      const existing = byNode.get(node);
      if (existing) return existing.symbolId;
      const nameNode = declarationNameNode(node, ts);
      return nameNode ? symbolKey(checker.getSymbolAtLocation(nameNode)) : null;
    },
    symbolIdForSymbol(symbol) { return symbolKey(symbol); },
    symbolIdForCall(callExpressionOrNode) {
      const expression = ts.isCallExpression(callExpressionOrNode) ? callExpressionOrNode.expression : callExpressionOrNode;
      let symbol = null;
      try { symbol = checker.getSymbolAtLocation(expression); } catch { /* unresolved */ }
      return symbolKey(symbol);
    },
    resolveCall,
    classifyCall,
    getEntryForNode(node) { return byNode.get(node) ?? null; },
    getEntryBySymbolId(symbolId) { return bySymbolId.get(symbolId) ?? null; },
  });
}

const PURE_INTRINSICS = new Set([
  'Math.abs', 'Math.ceil', 'Math.floor', 'Math.max', 'Math.min', 'Math.round',
  'Math.trunc', 'Number.isFinite', 'Number.isInteger', 'Number.isNaN',
  'String', 'Boolean', 'Number',
]);
