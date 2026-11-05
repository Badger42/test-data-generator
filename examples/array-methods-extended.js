export function filterEnabledItems(input) {
  return input.items.filter(item => {
    if (item.enabled) return true;
    if (item.score > 10) return true;
    return false;
  });
}

export function filterByPredicate(input) {
  return input.items.filter(item => item.active).length;
}

export function findFirstAdult(input) {
  if (input.people.find(person => person.age >= 18)) return 'found';
  return 'missing';
}

export function findIndexOfSecondActive(input) {
  if (input.items.findIndex((item, index) => index === 1 && item.active) >= 0) return true;
  return false;
}

export function findIndexNotFound(input) {
  if (input.items.findIndex(item => item.id === input.targetId) === -1) return true;
  return false;
}

export function reduceActiveCount(input) {
  return input.items.reduce((total, item, index) => {
    if (item.active) return total + 1;
    if (item.score > 10) return total + 2;
    return total;
  }, 0);
}

export function reduceWithoutInitial(input) {
  return input.values.reduce((total, value) => {
    if (total > 10) return total - value;
    if (value > 5) return total + value;
    return total;
  });
}


export function findOptionalValue(input) {
  if (input.people.find(person => person.active) !== undefined) return 'found';
  return 'missing';
}

export function reduceWithObjectSeed(input) {
  return input.items.reduce((accumulator, item) => {
    if (accumulator.threshold > 2) return { ...accumulator, total: accumulator.total + item.amount };
    if (item.amount > 5) return { ...accumulator, total: accumulator.total + 1 };
    return accumulator;
  }, input.seed);
}
