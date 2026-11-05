export function minimalSwitchTarget(input) {
  switch (input.kind) {
    case 'A': return 'alpha';
    case 'B': return 'beta';
    default: return 'other';
  }
}
