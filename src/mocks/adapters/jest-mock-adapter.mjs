function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sameArgs(actual, expected) {
  return stableStringify(actual) === stableStringify(expected);
}

function getHandler(handlers, id) {
  return handlers instanceof Map ? handlers.get(id) : handlers?.[id];
}

function cloneAction(mock) {
  return {
    callId: mock.callId ?? mock.call ?? mock.callExpression ?? mock.mockTarget?.id ?? 'unknown-call',
    callExpression: mock.callExpression ?? mock.call ?? mock.callId ?? 'unknown-call',
    mockTarget: mock.mockTarget,
    behavior: mock.behavior ?? 'mockReturnValue',
    ...(Object.prototype.hasOwnProperty.call(mock, 'resolvedValue') ? { value: mock.resolvedValue }
      : Object.prototype.hasOwnProperty.call(mock, 'value') ? { value: mock.value } : {}),
    ...(mock.error ? { error: mock.error } : {}),
    ...(mock.sequence ? { sequence: mock.sequence } : {}),
    ...(mock.cases ? { cases: mock.cases } : {}),
    ...(mock.defaultAction ? { defaultAction: mock.defaultAction } : {}),
    ...(mock.handlerId ? { handlerId: mock.handlerId } : {}),
  };
}

function setExportPath(root, exportPath, value) {
  if (!exportPath?.length) return value;
  let current = root;
  for (let index = 0; index < exportPath.length - 1; index += 1) {
    const key = exportPath[index];
    if (!current[key] || (typeof current[key] !== 'object' && typeof current[key] !== 'function')) current[key] = {};
    current = current[key];
  }
  current[exportPath[exportPath.length - 1]] = value;
  return root;
}

function getPath(root, parts = []) {
  return parts.reduce((value, key) => value == null ? undefined : value[key], root);
}

function actionSemantics(action) {
  const copy = { ...action };
  delete copy.callId;
  delete copy.callExpression;
  delete copy.callSiteId;
  delete copy.mockTarget;
  delete copy.callArguments;
  return stableStringify(copy);
}

/**
 * Applies JSON-safe mock descriptions to Jest. Module targets are registered
 * before the analyzed module is imported; object/global targets are patched
 * per scenario and restored between test.each rows.
 */
export function createJestMockAdapter(options = {}) {
  const handlers = options.handlers ?? new Map();
  const registry = new Map();
  const dynamicRestorers = [];
  const diagnostics = [];

  function createMock(jestApi, targetId) {
    const existing = registry.get(targetId);
    if (existing) return existing;
    if (typeof jestApi?.fn !== 'function') throw new TypeError('Jest mock adapter requires jest.fn().');
    const mockFn = jestApi.fn();
    registry.set(targetId, mockFn);
    return mockFn;
  }

  function resolveModuleReference(target, resolveModule) {
    if (typeof resolveModule === 'function') {
      try {
        const resolved = target.resolvedModulePath
          ? resolveModule(target.resolvedModulePath, target)
          : resolveModule(target.moduleSpecifier, target);
        if (resolved) return resolved;
      } catch { /* Fall through to Jest's own resolver for the original specifier. */ }
    }
    if (target.resolvedModulePath) return target.resolvedModulePath;
    if (target.moduleSpecifier && !target.moduleSpecifier.startsWith('.') && !target.moduleSpecifier.startsWith('/')) {
      return target.moduleSpecifier;
    }
    return null;
  }

  async function prepare(targets, jestApi, prepareOptions = {}) {
    const moduleGroups = new Map();
    diagnostics.length = 0;
    for (const target of targets ?? []) {
      if (!target || target.support !== 'automatic') {
        if (target) diagnostics.push({
          code: 'MOCK_TARGET_REQUIRES_MANUAL_SETUP',
          targetId: target.id ?? null,
          reason: target.reason ?? 'The mock target cannot be resolved automatically.',
        });
        continue;
      }
      if (target.kind !== 'module-export') continue;
      const moduleReference = resolveModuleReference(target, prepareOptions.resolveModule);
      if (!moduleReference) {
        diagnostics.push({
          code: 'MOCK_MODULE_NOT_RESOLVED',
          targetId: target.id,
          reason: `Cannot resolve module '${target.moduleSpecifier}' from the analyzed source file.`,
        });
        continue;
      }
      const key = `${target.moduleMode}:${moduleReference}`;
      if (!moduleGroups.has(key)) moduleGroups.set(key, { key, moduleMode: target.moduleMode, moduleReference, targets: [] });
      moduleGroups.get(key).targets.push(target);
    }

    for (const group of moduleGroups.values()) {
      const moduleExports = {};
      let rootExport = null;
      for (const target of group.targets) {
        const mockFn = createMock(jestApi, target.id);
        if (!target.exportPath?.length) rootExport = mockFn;
        else setExportPath(moduleExports, target.exportPath, mockFn);
      }

      if (group.moduleMode === 'esm') {
        if (typeof jestApi?.unstable_mockModule !== 'function') {
          diagnostics.push({
            code: 'JEST_ESM_MOCKING_UNAVAILABLE',
            module: group.moduleReference,
            reason: 'The current Jest runtime does not expose unstable_mockModule().',
          });
          continue;
        }
        await jestApi.unstable_mockModule(group.moduleReference, () => {
          if (!rootExport) return moduleExports;
          return Object.assign(rootExport, moduleExports);
        });
      } else {
        if (typeof jestApi?.mock !== 'function') {
          diagnostics.push({
            code: 'JEST_COMMONJS_MOCKING_UNAVAILABLE',
            module: group.moduleReference,
            reason: 'The current Jest runtime does not expose jest.mock().',
          });
          continue;
        }
        jestApi.mock(group.moduleReference, () => {
          let actual = {};
          try { actual = jestApi.requireActual?.(group.moduleReference) ?? {}; } catch { /* Partial mock fallback. */ }
          if (rootExport) {
            if (actual && (typeof actual === 'object' || typeof actual === 'function')) Object.assign(rootExport, actual);
            return rootExport;
          }
          const output = actual && (typeof actual === 'object' || typeof actual === 'function')
            ? Object.assign({}, actual) : {};
          for (const target of group.targets) {
            if (target.exportPath?.length) setExportPath(output, target.exportPath, registry.get(target.id));
          }
          output.__esModule = true;
          return output;
        });
      }
    }

    return Object.freeze({
      preparedModules: moduleGroups.size,
      preparedTargets: Object.freeze([...registry.keys()]),
      diagnostics: Object.freeze([...diagnostics]),
      requiresManualSetup: diagnostics.length > 0,
    });
  }

  function restoreDynamic() {
    for (const restore of dynamicRestorers.splice(0).reverse()) {
      try { restore(); } catch (error) {
        diagnostics.push({ code: 'MOCK_TARGET_RESTORE_FAILED', reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  function reset() {
    restoreDynamic();
    for (const mockFn of new Set(registry.values())) {
      if (typeof mockFn.mockReset === 'function') mockFn.mockReset();
      else if (typeof mockFn.mockClear === 'function') mockFn.mockClear();
    }
  }

  function patchTarget(target, jestApi, args, targetReceiver) {
    if (target.support !== 'automatic') return null;
    if (target.kind === 'module-export') return registry.get(target.id) ?? null;
    const mockFn = createMock(jestApi, target.id);

    if (target.kind === 'parameter-callable') {
      const previous = args[target.parameterIndex];
      args[target.parameterIndex] = mockFn;
      dynamicRestorers.push(() => { args[target.parameterIndex] = previous; });
      return mockFn;
    }

    let root;
    if (target.kind === 'object-member') root = args?.[target.parameterIndex];
    else if (target.kind === 'this-member') root = targetReceiver;
    else if (target.kind === 'global-member') {
      root = target.globalName === 'globalThis' ? globalThis : globalThis[target.globalName];
      if (root == null) {
        diagnostics.push({ code: 'MOCK_GLOBAL_UNAVAILABLE', targetId: target.id, reason: `Global '${target.globalName}' is not available in this Jest environment.` });
        return null;
      }
    } else return null;

    const receiver = getPath(root, target.receiverPath);
    if ((typeof receiver !== 'object' && typeof receiver !== 'function') || receiver === null) {
      diagnostics.push({
        code: 'MOCK_RECEIVER_UNAVAILABLE',
        targetId: target.id,
        reason: `Cannot resolve mock receiver for member '${target.memberName}'.`,
      });
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(receiver, target.memberName);
    try {
      Object.defineProperty(receiver, target.memberName, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        writable: true,
        value: mockFn,
      });
    } catch (error) {
      diagnostics.push({
        code: 'MOCK_MEMBER_NOT_PATCHABLE',
        targetId: target.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    dynamicRestorers.push(() => {
      if (descriptor) Object.defineProperty(receiver, target.memberName, descriptor);
      else delete receiver[target.memberName];
    });
    return mockFn;
  }

  function applyStep(mockFn, step) {
    switch (step.behavior) {
      case 'mockReturnValue': mockFn.mockReturnValue(step.value); break;
      case 'mockResolvedValue': mockFn.mockResolvedValue(step.value); break;
      case 'mockRejectedValue': mockFn.mockRejectedValue(step.error ?? step.value); break;
      case 'mockImplementation': {
        const implementation = getHandler(handlers, step.handlerId);
        if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${step.handlerId}' is not registered.`);
        mockFn.mockImplementation(implementation);
        break;
      }
      default: throw new TypeError(`Unsupported Jest mock behavior '${step.behavior}'.`);
    }
  }

  function apply(mockPlan, suppliedRegistry = registry) {
    const applied = [];
    for (const action of mockPlan?.actions ?? []) {
      const mockFn = suppliedRegistry instanceof Map
        ? (action.mockTarget?.id ? suppliedRegistry.get(action.mockTarget.id) : null) ??
          suppliedRegistry.get(action.callId) ?? suppliedRegistry.get(action.callExpression)
        : suppliedRegistry[action.mockTarget?.id] ?? suppliedRegistry[action.callId] ?? suppliedRegistry[action.callExpression];
      if (!mockFn) {
        diagnostics.push({
          code: 'MOCK_FUNCTION_NOT_REGISTERED',
          targetId: action.mockTarget?.id ?? null,
          callExpression: action.callExpression,
          reason: `No Jest mock is registered for '${action.callExpression}'.`,
        });
        continue;
      }

      if (action.behavior === 'sequence') {
        for (const step of action.sequence ?? []) {
          const method = `${step.behavior}Once`;
          if (typeof mockFn[method] !== 'function') throw new TypeError(`Jest mock does not implement ${method}().`);
          if (step.behavior === 'mockImplementation') {
            const implementation = getHandler(handlers, step.handlerId);
            if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${step.handlerId}' is not registered.`);
            mockFn.mockImplementationOnce(implementation);
          } else if (step.behavior === 'mockRejectedValue') mockFn.mockRejectedValueOnce(step.error ?? step.value);
          else mockFn[method](step.value);
        }
      } else if (action.behavior === 'conditional') {
        const cases = action.cases ?? [];
        const fallback = action.defaultAction;
        mockFn.mockImplementation((...args) => {
          const match = cases.find(item => item.when?.args && sameArgs(args, item.when.args));
          const selected = match?.action ?? fallback;
          if (!selected) throw new Error(`No conditional mock case matched '${action.callExpression}'.`);
          switch (selected.behavior) {
            case 'mockReturnValue': return selected.value;
            case 'mockResolvedValue': return Promise.resolve(selected.value);
            case 'mockRejectedValue': return Promise.reject(selected.error ?? selected.value);
            case 'mockImplementation': {
              const implementation = getHandler(handlers, selected.handlerId);
              if (typeof implementation !== 'function') throw new Error(`Mock implementation handler '${selected.handlerId}' is not registered.`);
              return Reflect.apply(implementation, this, args);
            }
            default: throw new TypeError(`Unsupported conditional mock behavior '${selected.behavior}'.`);
          }
        });
      } else {
        applyStep(mockFn, action);
      }
      applied.push(action.callId);
    }
    return { applied, diagnostics: [...diagnostics] };
  }

  function conditionalAction(group) {
    const candidates = group.map(cloneAction);
    if (candidates.every(item => actionSemantics(item) === actionSemantics(candidates[0]))) {
      return { action: candidates[0] };
    }

    const cases = new Map();
    for (const mock of group) {
      const args = (mock.callArguments ?? []).slice().sort((left, right) => left.index - right.index);
      if (args.some(argument => !argument.resolvedFromScenario || !Object.prototype.hasOwnProperty.call(argument, 'value'))) {
        return { diagnostic: {
          code: 'MOCK_COLLISION_ARGUMENTS_UNRESOLVED',
          targetId: mock.mockTarget.id,
          reason: 'Several calls share one dependency target, but their concrete arguments cannot be distinguished safely.',
        } };
      }
      const values = args.map(argument => argument.value);
      const action = cloneAction(mock);
      delete action.mockTarget;
      delete action.callArguments;
      const key = stableStringify(values);
      const existing = cases.get(key);
      if (existing && actionSemantics(existing) !== actionSemantics(action)) {
        return { diagnostic: {
          code: 'MOCK_COLLISION_AMBIGUOUS',
          targetId: mock.mockTarget.id,
          reason: 'The same dependency was called with identical arguments but requires different values at distinct call sites.',
        } };
      }
      cases.set(key, action);
    }
    return {
      action: {
        callId: group[0].mockTarget.id,
        callExpression: group.map(item => item.callExpression ?? item.call).join(' | '),
        mockTarget: group[0].mockTarget,
        behavior: 'conditional',
        cases: [...cases.entries()].map(([args, action]) => ({ when: { args: JSON.parse(args) }, action })),
      },
    };
  }

  function applyScenario(mocks, args, targetReceiver, jestApi) {
    const targets = [...new Map((mocks ?? []).filter(item => item.mockTarget).map(item => [
      item.mockTarget.id, item.mockTarget,
    ])).values()];
    const scenarioRegistry = new Map(registry);
    for (const target of targets) {
      if (target.kind === 'module-export') continue;
      const mockFn = patchTarget(target, jestApi, args, targetReceiver);
      if (mockFn) scenarioRegistry.set(target.id, mockFn);
    }

    const grouped = new Map();
    for (const mock of (mocks ?? []).filter(item => item.mockTarget?.support === 'automatic')) {
      const targetId = mock.mockTarget.id;
      if (!grouped.has(targetId)) grouped.set(targetId, []);
      grouped.get(targetId).push(mock);
    }
    const actions = [];
    for (const group of grouped.values()) {
      if (group.length === 1) actions.push(cloneAction(group[0]));
      else {
        const result = conditionalAction(group);
        if (result.diagnostic) diagnostics.push(result.diagnostic);
        else actions.push(result.action);
      }
    }
    const result = apply({ actions }, scenarioRegistry);
    for (const mock of (mocks ?? []).filter(item => item.mockTarget?.support !== 'automatic')) {
      diagnostics.push({
        code: 'MOCK_TARGET_REQUIRES_MANUAL_SETUP',
        targetId: mock.mockTarget?.id ?? null,
        reason: mock.mockTarget?.reason ?? 'The mock target cannot be applied automatically.',
      });
    }
    return { applied: result.applied, diagnostics: result.diagnostics };
  }

  return Object.freeze({ prepare, apply, applyScenario, reset, diagnostics: () => [...diagnostics] });
}
