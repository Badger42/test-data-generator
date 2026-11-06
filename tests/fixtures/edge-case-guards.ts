export function destructuredGuard({ a, b }: { a: boolean; b: boolean }) {
  if (a && !b) return 'match';
  return 'other';
}

export function moduloFifteen(input: { n: number }) {
  if (input.n > 0 && input.n % 3 === 0 && input.n % 5 === 0) return 'fifteen';
  return 'other';
}

export function unsupportedTypeof(input: { value: unknown }) {
  if (typeof input.value === 'string') return 'string';
  return 'other';
}
