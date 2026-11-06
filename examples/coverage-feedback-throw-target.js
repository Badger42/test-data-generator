export function throwOnNegative(input) {
  if (input.age < 0) throw new RangeError('negative age');
  return 'ok';
}
