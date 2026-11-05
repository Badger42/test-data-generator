/** Stable call-site identity independent of the source machine's absolute path. */
export function createCallSiteIdentity(input) {
  const file = String(input.relativeFile ?? input.file ?? '').replace(/\\/g, '/');
  const start = Number.isInteger(input.startOffset) ? input.startOffset : 0;
  const end = Number.isInteger(input.endOffset) ? input.endOffset : start;
  const expression = String(input.callExpression ?? input.expression ?? 'unknown-call');
  return Object.freeze({
    callId: expression,
    callExpression: expression,
    callSiteId: `${file}:${start}:${end}`,
  });
}
