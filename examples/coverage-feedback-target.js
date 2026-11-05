export function coverageTarget(input) {
  if (input.enabled && input.score > 10) {
    return 'active';
  }
  return 'inactive';
}
