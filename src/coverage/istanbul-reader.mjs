/** Normalize Istanbul JSON input and summarize statement/function/branch counters. */
export function readIstanbulCoverage(fileName, fs) {
  return JSON.parse(fs.readFileSync(fileName, 'utf8'));
}
export function summarizeCounterMap(counterMap) {
  const values = Object.values(counterMap ?? {}).flatMap(value => Array.isArray(value) ? value : [value]);
  const covered = values.filter(value => Number(value) > 0).length;
  return {
    covered,
    total: values.length,
    pct: values.length ? Number((covered / values.length * 100).toFixed(2)) : null,
  };
}
