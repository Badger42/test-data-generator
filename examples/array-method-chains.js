export function filteredMappedSome(input) {
  return input.items
    .filter(item => item.active)
    .map(item => item.price)
    .some(price => price > 10);
}

export function mappedObjectThenSome(input) {
  return input.items
    .map(item => ({ amount: item.price, enabled: item.active }))
    .some(row => row.amount > 10 && row.enabled);
}

export function mappedFilterThenFind(input) {
  return input.items
    .map(item => item.profile)
    .filter(profile => profile.active)
    .find(profile => profile.score >= 5) !== undefined;
}

export function filterMapFilterCount(input) {
  return input.items
    .filter(item => item.active)
    .map(item => item.price)
    .filter(price => price > 0).length;
}

export function reduceWithInterIterationState(input) {
  return input.values.reduce((total, value, index) => {
    if (total > 10) return total - value;
    if (value > 5) return total + value;
    return total + value;
  }, 0);
}

export function reduceWithoutInitialInterIterationState(input) {
  return input.values.reduce((total, value) => {
    if (total > 10) return total - value;
    return total + value;
  });
}

export function reduceObjectAccumulatorAcrossIterations(input) {
  return input.items.reduce((accumulator, item) => {
    if (accumulator.total > 10) {
      return { ...accumulator, total: accumulator.total - item.amount };
    }
    if (item.amount > 5) {
      return { ...accumulator, total: accumulator.total + item.amount };
    }
    return { ...accumulator, total: accumulator.total + item.amount };
  }, { total: 0 });
}

export function reduceAfterTwoPriorIterations(input) {
  return input.values.reduce((total, value) => {
    if (total >= 10) return total - value;
    return total + value;
  }, 0);
}

export function reduceWithoutInitialAfterTwoPriorIterations(input) {
  return input.values.reduce((total, value) => {
    if (total >= 10) return total - value;
    return total + value;
  });
}


export function reduceObjectAccumulatorAfterTwoIterations(input) {
  return input.items.reduce((accumulator, item) => {
    if (accumulator.total >= 10) {
      return { ...accumulator, total: accumulator.total - item.amount };
    }
    return { ...accumulator, total: accumulator.total + item.amount };
  }, { total: 0 });
}

export function flatMappedPassengerSome(input) {
  return input.groups
    .flatMap(group => group.passengers)
    .some(passenger => passenger.age >= 18);
}

export function reduceMutatingObjectAfterTwoIterations(input) {
  return input.items.reduce((accumulator, item) => {
    accumulator.total += item.amount;
    if (accumulator.total >= 10) return accumulator;
    return accumulator;
  }, { total: 0 });
}
