import { isSupportedArrayCallbackMethod } from '../../domain/array-method-policy.mjs';

/**
 * TypeScript-AST-aware callback discovery. The TypeScript API and all semantic
 * helpers are injected so this module does not load the compiler itself.
 */
export function createArrayCallbackDiscovery(ports) {
  const {
    ts,
    unwrap,
    getPathWithAliases,
    getLiteral,
    isFunctionLikeCallback,
    callbackMethods,
    reduceMethods,
    comparatorMethods,
  } = ports;

  function getReceiverModel(receiver, ctx) {
    const current = unwrap(receiver);
    if (!current) return null;

    if (ts.isCallExpression(current)) {
      const expression = unwrap(current.expression);
      if (expression && ts.isPropertyAccessExpression(expression)) {
        const method = expression.name.text;
        const previous = getReceiverModel(expression.expression, ctx);
        if (method === 'flat' && previous) {
          const depthLiteral = current.arguments.length ? getLiteral(current.arguments[0]) : { ok: true, value: 1 };
          const depth = depthLiteral.ok && typeof depthLiteral.value === 'number'
            ? Math.max(0, Math.min(3, Math.floor(depthLiteral.value))) : 1;
          return { collectionPath: previous.collectionPath, stages: [...previous.stages, { method, depth, call: current }] };
        }
        if (['reverse', 'toReversed', 'slice'].includes(method) && previous) {
          const startLiteral = method === 'slice' && current.arguments.length ? getLiteral(current.arguments[0]) : { ok: true, value: 0 };
          const start = startLiteral.ok && typeof startLiteral.value === 'number' ? Math.max(0, Math.floor(startLiteral.value)) : 0;
          return { collectionPath: previous.collectionPath, stages: [...previous.stages, { method, start, call: current }] };
        }
        if (comparatorMethods.has(method) && previous) {
          const callback = current.arguments.find(isFunctionLikeCallback) ?? null;
          return { collectionPath: previous.collectionPath, stages: [...previous.stages, { method, callback, call: current }] };
        }
        if (callbackMethods.has(method) || reduceMethods.has(method)) {
          const callback = current.arguments.find(isFunctionLikeCallback);
          if (!previous || !callback) return null;
          return {
            collectionPath: previous.collectionPath,
            stages: [...previous.stages, { method, callback, call: current }],
          };
        }
        // Non-transforming built-ins preserve the representative element shape.
        if (['slice', 'toReversed'].includes(method)) return previous;
      }
    }

    const collectionPath = getPathWithAliases(current, ctx.pathAliases);
    if (!collectionPath || !ctx.parameterMap.has(collectionPath[0])) return null;
    return { collectionPath, stages: [] };
  }

  function getDescriptor(call, ctx) {
    const current = unwrap(call);
    if (!current || !ts.isCallExpression(current)) return null;
    const expression = unwrap(current.expression);
    if (!expression || !ts.isPropertyAccessExpression(expression)) return null;
    const method = expression.name.text;
    const isReduce = reduceMethods.has(method);
    if (!isSupportedArrayCallbackMethod(method)) return null;
    const receiver = getReceiverModel(expression.expression, ctx);
    if (!receiver) return null;
    const callback = current.arguments.find(isFunctionLikeCallback);
    if (!callback) return null;
    return {
      call: current,
      method,
      collectionPath: receiver.collectionPath,
      pipeline: receiver.stages,
      callback,
      isReduce,
      hasInitialValue: isReduce && current.arguments.length > 1,
      initialValue: isReduce && current.arguments.length > 1 ? current.arguments[1] : null,
    };
  }

  return Object.freeze({
    getReceiverModel,
    getDescriptor,
    isSupportedMethod: isSupportedArrayCallbackMethod,
  });
}
