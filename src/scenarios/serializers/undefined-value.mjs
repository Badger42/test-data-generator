const DEFAULT_MARKER = Object.freeze({ $undefined: true });

function isSerializedUndefined(value, marker) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && value.$undefined === marker.$undefined);
}

/** Keeps JS undefined internal and converts it to the stable JSON marker only at serialization boundaries. */
export function createUndefinedValueSerializer(options = {}) {
  const undefinedValue = options.undefinedValue;
  const marker = Object.freeze({ ...(options.marker ?? DEFAULT_MARKER) });
  const isUndefined = value => value === undefined || (undefinedValue !== undefined && value === undefinedValue);

  function serialize(value, seen = new WeakSet()) {
    if (isUndefined(value)) return { ...marker };
    if (isSerializedUndefined(value, marker)) return { ...marker };
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) throw new TypeError('Cannot serialize cyclic scenario values.');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => serialize(item, seen));
    else {
      result = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
        result[key] = serialize(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }

  function deserialize(value) {
    if (isSerializedUndefined(value, marker)) return undefined;
    if (Array.isArray(value)) return value.map(deserialize);
    if (value && typeof value === 'object') {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
        result[key] = deserialize(item);
      }
      return result;
    }
    return value;
  }

  return Object.freeze({ marker, isUndefined, serialize, deserialize });
}
