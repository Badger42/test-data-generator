import path from 'node:path';

function accessPath(expression, ts) {
  const segments = [];
  let current = expression;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) {
    if (ts.isPropertyAccessExpression(current)) segments.unshift(current.name.text);
    else {
      const argument = current.argumentExpression;
      if (argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))) segments.unshift(String(argument.text));
      else return { root: current.expression, segments, dynamic: true };
    }
    current = current.expression;
  }
  return { root: current, segments, dynamic: false };
}

function declarationList(symbol) {
  return symbol?.declarations ?? (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
}

function ancestor(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
  return null;
}

function isRequireCall(node, ts) {
  return Boolean(node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]));
}

/** Maps a TypeScript external call-site to a portable, JSON-safe runtime mock target. */
export function createMockTargetResolver(ts) {
  if (!ts) throw new TypeError('MockTargetResolver requires an injected TypeScript API.');

  function unknown(callExpression, reason) {
    return { version: 1, id: 'unresolved:' + callExpression.getText(), kind: 'unresolved', support: 'manual-setup-required', reason };
  }

  function resolveRuntimeModule(specifier, input) {
    if (!input.program || typeof ts.resolveModuleName !== 'function') return null;
    try {
      const resolved = ts.resolveModuleName(specifier, input.sourceFile.fileName,
        input.program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || /\.d\.(?:ts|mts|cts)$/i.test(resolved)) return null;
      const relative = path.relative(path.dirname(input.sourceFile.fileName), path.resolve(resolved)).split(path.sep).join('/');
      return relative.startsWith('.') ? relative : './' + relative;
    } catch {
      return null;
    }
  }

  function moduleTarget(specifier, exportPath, input) {
    const resolvedModulePath = resolveRuntimeModule(specifier, input);
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
    const support = relative && !resolvedModulePath ? 'manual-setup-required' : 'automatic';
    const moduleKind = input.program?.getCompilerOptions?.().module;
    const commonJs = /\.(?:cjs|cts)$/i.test(input.sourceFile.fileName) ||
      /\.(?:cjs|cts)$/.test(specifier) ||
      (moduleKind != null && [ts.ModuleKind.CommonJS, ts.ModuleKind.AMD, ts.ModuleKind.UMD, ts.ModuleKind.System].includes(moduleKind));
    const mode = commonJs ? 'commonjs' : 'esm';
    return {
      version: 1,
      id: ['module', mode, specifier, exportPath.join('.')].join(':'),
      kind: 'module-export',
      support,
      moduleMode: mode,
      moduleSpecifier: specifier,
      ...(resolvedModulePath ? { resolvedModulePath } : {}),
      exportPath,
      ...(support !== 'automatic' ? { reason: 'The relative module could not be resolved to a runtime file by the TypeScript project.' } : {}),
    };
  }

  function fromImport(root, segments, input) {
    let symbol;
    try { symbol = input.checker.getSymbolAtLocation(root); } catch { return null; }
    const declaration = declarationList(symbol).find(item =>
      ts.isImportSpecifier(item) || ts.isNamespaceImport(item) || ts.isImportClause(item));
    if (!declaration) return null;
    const statement = ancestor(declaration, ts.isImportDeclaration);
    const specifier = statement?.moduleSpecifier;
    if (!specifier || !ts.isStringLiteralLike(specifier) || statement.importClause?.isTypeOnly) return null;
    let exportPath;
    if (ts.isImportSpecifier(declaration)) {
      if (declaration.isTypeOnly) return null;
      exportPath = [declaration.propertyName?.text ?? declaration.name.text, ...segments];
    } else if (ts.isNamespaceImport(declaration)) {
      if (!segments.length) return null;
      exportPath = segments;
    } else {
      exportPath = ['default', ...segments];
    }
    return moduleTarget(specifier.text, exportPath, input);
  }

  function fromRequire(root, segments, input) {
    if (isRequireCall(root, ts)) return moduleTarget(root.arguments[0].text, segments, input);
    let symbol;
    try { symbol = input.checker.getSymbolAtLocation(root); } catch { return null; }
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration) && isRequireCall(declaration.initializer, ts)) {
      return moduleTarget(declaration.initializer.arguments[0].text, segments, input);
    }
    if (declaration && ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const variable = pattern?.parent;
      if (pattern && ts.isObjectBindingPattern(pattern) && variable && ts.isVariableDeclaration(variable) &&
          isRequireCall(variable.initializer, ts)) {
        const name = declaration.propertyName?.getText(input.sourceFile) ?? declaration.name.getText(input.sourceFile);
        return moduleTarget(variable.initializer.arguments[0].text, [name, ...segments], input);
      }
    }
    return null;
  }

  function fromParameter(root, segments, input) {
    let symbol;
    try { symbol = input.checker.getSymbolAtLocation(root); } catch { return null; }
    const parameter = declarationList(symbol).find(item => ts.isParameter(item));
    if (!parameter) return null;
    const owner = parameter.parent;
    const index = owner?.parameters?.indexOf(parameter) ?? -1;
    if (owner !== input.functionNode || index < 0) {
      return unknown(input.callExpression, 'The callable belongs to a nested-function parameter; its runtime binding is not a top-level scenario argument.');
    }
    if (!segments.length) {
      return { version: 1, id: 'parameter-callable:' + index, kind: 'parameter-callable', support: 'automatic', parameterIndex: index };
    }
    const memberName = segments[segments.length - 1];
    return {
      version: 1,
      id: 'parameter:' + index + ':' + segments.slice(0, -1).join('.') + ':' + memberName,
      kind: 'object-member',
      support: 'automatic',
      parameterIndex: index,
      receiverPath: segments.slice(0, -1),
      memberName,
    };
  }

  function fromThis(root, segments, input) {
    if (root.kind !== ts.SyntaxKind.ThisKeyword) return null;
    if (!segments.length) return unknown(input.callExpression, 'A callable this reference without a member path cannot be patched safely.');
    const memberName = segments[segments.length - 1];
    return {
      version: 1,
      id: 'this:' + segments.slice(0, -1).join('.') + ':' + memberName,
      kind: 'this-member',
      support: 'automatic',
      receiverPath: segments.slice(0, -1),
      memberName,
    };
  }

  function fromGlobal(root, segments, input) {
    if (!ts.isIdentifier(root)) return null;
    const globalObjects = new Set([
      'globalThis', 'window', 'self', 'document', 'navigator', 'process',
      'console', 'crypto', 'performance', 'location', 'localStorage', 'sessionStorage',
    ]);
    const globalFunctions = new Set([
      'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'alert', 'confirm', 'prompt',
    ]);
    const memberAllowlist = {
      globalThis: globalFunctions,
      window: new Set(['fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'open', 'postMessage']),
      self: new Set(['fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'postMessage']),
      document: new Set(['querySelector', 'querySelectorAll', 'getElementById', 'createElement', 'createTextNode']),
      navigator: new Set(['sendBeacon', 'share', 'clipboard', 'geolocation']),
      process: new Set(['cwd', 'chdir', 'exit', 'nextTick', 'hrtime']),
      console: new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'table']),
      crypto: new Set(['randomUUID', 'getRandomValues', 'subtle']),
      performance: new Set(['now', 'mark', 'measure']),
      location: new Set(['assign', 'replace', 'reload']),
      localStorage: new Set(['getItem', 'setItem', 'removeItem', 'clear']),
      sessionStorage: new Set(['getItem', 'setItem', 'removeItem', 'clear']),
    };

    if (root.text === 'globalThis') {
      if (segments.length === 1 && globalFunctions.has(segments[0])) {
        return {
          version: 1,
          id: 'global:globalThis::' + segments[0],
          kind: 'global-member',
          support: 'automatic',
          globalName: 'globalThis',
          receiverPath: [],
          memberName: segments[0],
        };
      }
      if (segments.length === 2 && globalObjects.has(segments[0]) && memberAllowlist[segments[0]]?.has(segments[1])) {
        return {
          version: 1,
          id: 'global:globalThis:' + segments[0] + ':' + segments[1],
          kind: 'global-member',
          support: 'automatic',
          globalName: 'globalThis',
          receiverPath: [segments[0]],
          memberName: segments[1],
        };
      }
      return unknown(input.callExpression, 'Custom globalThis properties are not patched automatically; use the scenario mock hook or an imported/DI dependency seam.');
    }

    if (!globalObjects.has(root.text) || segments.length !== 1 || !memberAllowlist[root.text]?.has(segments[0])) {
      return null;
    }
    return {
      version: 1,
      id: 'global:' + root.text + '::' + segments[0],
      kind: 'global-member',
      support: 'automatic',
      globalName: root.text,
      receiverPath: [],
      memberName: segments[0],
    };
  }

  function resolve(callExpression, input) {
    input = { ...input, callExpression };
    const access = accessPath(callExpression.expression, ts);
    if (access.dynamic) return unknown(callExpression, 'A dynamic computed member cannot be resolved to a stable Jest target.');
    return fromImport(access.root, access.segments, input) ??
      fromRequire(access.root, access.segments, input) ??
      fromParameter(access.root, access.segments, input) ??
      fromThis(access.root, access.segments, input) ??
      fromGlobal(access.root, access.segments, input) ??
      unknown(callExpression, 'The external call could not be mapped to a supported module, DI parameter, this member, or global API.');
  }

  return Object.freeze({ resolve });
}
