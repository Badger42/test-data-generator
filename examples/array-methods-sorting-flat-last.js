export function findLastAdult(input) {
  if (input.people.findLast(person => person.age >= 18 && person.active)) return true;
  return false;
}

export function findLastIndexSecondActive(input) {
  if (input.items.findLastIndex((item, index) => index === 1 && item.active) >= 0) return true;
  return false;
}

export function findLastIndexNotFound(input) {
  if (input.items.findLastIndex(item => item.id === input.targetId) === -1) return true;
  return false;
}

export function sortByPrice(input) {
  const sorted = input.items.sort((left, right) => {
    if (left.price < right.price) return -1;
    if (left.price === right.price) return 0;
    return 1;
  });
  return sorted[0]?.price;
}

export function toSortedByPriority(input) {
  return input.items.toSorted((left, right) =>
    left.priority > right.priority ? -1 : 1
  ).map(item => item.priority);
}

export function flatGroupsFindAdult(input) {
  return input.groups.flat().findLast(person => person.age >= 18 && person.active) !== undefined;
}

export function flatDepthTwoFindFlag(input) {
  return input.matrix.flat(2).some(item => item.flag === true);
}

export function sortedThenSome(input) {
  return input.items.toSorted().some(item => item === 'active');
}

export function defaultSortThenSome(input) {
  return input.items.sort().some(item => item === 'a');
}
