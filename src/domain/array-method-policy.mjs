/** Method families shared by callback discovery and scenario analysis. */
export const ARRAY_CALLBACK_METHODS = Object.freeze(new Set([
  'forEach', 'map', 'flatMap', 'some', 'every', 'filter', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'sort', 'toSorted',
]));
export const ARRAY_REDUCE_METHODS = Object.freeze(new Set(['reduce']));
export const ARRAY_PREDICATE_METHODS = Object.freeze(new Set([
  'some', 'every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex',
]));
export const ARRAY_COMPARATOR_METHODS = Object.freeze(new Set(['sort', 'toSorted']));
export const ARRAY_SEARCH_METHODS = Object.freeze(new Set([
  'some', 'find', 'findIndex', 'findLast', 'findLastIndex',
]));
export const ARRAY_LAST_SEARCH_METHODS = Object.freeze(new Set(['findLast', 'findLastIndex']));

export function isSupportedArrayCallbackMethod(method) {
  return ARRAY_CALLBACK_METHODS.has(method) || ARRAY_REDUCE_METHODS.has(method);
}

/**
 * Returns representative cardinality outcomes for one callback operation.
 * This is a bounded path exploration policy, not a claim about every possible
 * collection length or every invocation count.
 */
export function getCallbackCardinalityVariants(method, { itemValue, hasInitialValue = false, secondItemValue = itemValue } = {}) {
  if (ARRAY_COMPARATOR_METHODS.has(method)) {
    return [{ outcome: 'comparator-pair', value: [itemValue, secondItemValue], phase: 'compare-two-elements' }];
  }
  if (ARRAY_REDUCE_METHODS.has(method)) {
    return hasInitialValue
      ? [
          { outcome: 'zero-callbacks', value: [], phase: 'initial-value-only' },
          { outcome: 'one-callback', value: [itemValue], phase: 'first-reduction' },
          { outcome: 'multiple-callbacks', value: [itemValue, itemValue], phase: 'repeated-reduction' },
        ]
      : [
          { outcome: 'one-callback', value: [itemValue, itemValue], phase: 'first-reduction-after-seed' },
          { outcome: 'multiple-callbacks', value: [itemValue, itemValue, itemValue], phase: 'repeated-reduction' },
        ];
  }
  if (ARRAY_SEARCH_METHODS.has(method)) {
    return [
      { outcome: 'zero-callbacks', value: [], phase: 'no-match' },
      { outcome: 'one-callback', value: [itemValue], phase: 'first-match-or-stop' },
      { outcome: 'multiple-callbacks', value: [itemValue, itemValue], phase: 'later-match-or-no-match' },
    ];
  }
  return [
    { outcome: 'zero-callbacks', value: [], phase: 'before-first-callback' },
    { outcome: 'one-callback', value: [itemValue], phase: 'first-callback' },
    { outcome: 'multiple-callbacks', value: [itemValue, itemValue], phase: 'repeated-callback' },
  ];
}

export function getCallbackIterationIndices(method, {
  hasInitialValue = false,
  callbackUsesIndex = false,
  hasReorderingPipeline = false,
} = {}) {
  if (ARRAY_REDUCE_METHODS.has(method)) return hasInitialValue ? [0, 1, 2] : [1, 2, 3];
  if (ARRAY_LAST_SEARCH_METHODS.has(method)) {
    return hasReorderingPipeline ? [1] : callbackUsesIndex ? [1, 0] : [0];
  }
  if (!ARRAY_COMPARATOR_METHODS.has(method) && callbackUsesIndex) return [0, 1];
  return [0];
}

export function getArrayPipelineResultKind(method) {
  if (['some', 'every'].includes(method)) return 'boolean';
  if (['find', 'findLast'].includes(method)) return 'element-or-undefined';
  if (['findIndex', 'findLastIndex'].includes(method)) return 'number-index';
  if (method === 'reduce') return 'accumulator';
  if (method === 'forEach') return 'undefined';
  return 'array';
}
