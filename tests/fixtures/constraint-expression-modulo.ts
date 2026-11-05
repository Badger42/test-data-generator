export function moduloBranch(input: { count: number }) {
  if (input.count % 2 === 0) return 'even';
  return 'odd';
}
