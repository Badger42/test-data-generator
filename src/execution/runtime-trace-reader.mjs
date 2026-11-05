/** Read optional execution-side JSON artifacts without failing the whole run. */
export function readRuntimeTraceFile(fileName, { fs, fallback = [] } = {}) {
  if (!fs.existsSync(fileName)) return fallback;
  try { return JSON.parse(fs.readFileSync(fileName, 'utf8')); }
  catch { return fallback; }
}
