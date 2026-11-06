export function throwOnNegative(input) {
  if (input.age < 0) throw new RangeError('negative age');
  return 'ok';
}

export function throwDifferentExceptions(input) {
  if (input.enabled) {
    throw new TypeError('enabled');
  } else {
    throw new RangeError('disabled');
  }
}
