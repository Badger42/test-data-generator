/** Strict parsing and bounded-output helpers shared by the test orchestrator. */
export function parsePositiveInteger(value, defaultValue, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value == null) return defaultValue;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer${Number.isFinite(maximum) ? ` not greater than ${maximum}` : ''}.`);
  }
  return parsed;
}

export function appendTail(current, chunk, maximumLength) {
  const combined = current + chunk;
  return combined.length > maximumLength ? combined.slice(-maximumLength) : combined;
}

export function assertNonEmptyTestFiles(files, directoryLabel = 'test directory') {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`No test modules were discovered under ${directoryLabel}; refusing to report an empty successful run.`);
  }
  return files;
}
