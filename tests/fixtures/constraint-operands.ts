export function compareLimits(input: { count: number; limit: number }) {
  if (input.count < input.limit) return 'below';
  return 'not-below';
}

export function classifyLength(input: { items: Array<{ active: boolean }> }) {
  if (input.items.length === 0) return 'empty';
  if (input.items.length >= 2 && input.items.length < 4) return 'small-batch';
  return 'other';
}

export function compareLengths(input: { left: string; right: string }) {
  if (input.left.length <= input.right.length) return 'left-shorter-or-equal';
  return 'left-longer';
}
