export function minimalSuiteTarget(input) {
  if (input.enabled && input.score >= 10) return 'active';
  if (input.region === 'NL') return 'local';
  return 'other';
}
