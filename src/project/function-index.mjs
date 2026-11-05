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

  const add = (node, sourceFile) => {
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
      exported: Boolean(resolved.declarations?.some(declaration => declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))),
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
    const visit = node => {
      if (isFunctionLike(node, ts)) add(node, sourceFile);
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
    if (declarationFile.includes('/node_modules/')) return { kind: 'external-dependency', confidence: 'high', symbolName: resolved?.getName?.() ?? text };
    if (/\/typescript\/lib\/lib\..+\.d\.ts$/i.test(declarationFile)) return { kind: 'builtin-opaque', confidence: 'medium', symbolName: resolved?.getName?.() ?? text };
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
