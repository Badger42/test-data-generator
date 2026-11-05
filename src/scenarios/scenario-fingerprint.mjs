function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

export function stableScenarioStringify(value) {
  return JSON.stringify(canonicalize(value));
}

/** Fingerprints the full runtime payload; mocks are intentionally not ignored. */
export function createScenarioFingerprint(input) {
  const mocks = [...(input.mocks ?? [])].map(mock => ({ ...mock })).sort((a, b) => {
    const left = String(a.call ?? a.callId ?? a.callExpression ?? '');
    const right = String(b.call ?? b.callId ?? b.callExpression ?? '');
    return left.localeCompare(right);
  });
  return stableScenarioStringify({ arguments: input.arguments ?? [], mocks });
}
