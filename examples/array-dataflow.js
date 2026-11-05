export function filteredSortedFlatMappedFindLast(input) {
  return input.flights
    .filter(flight => flight.active)
    .sort((left, right) => left.price - right.price)
    .flatMap(flight => flight.passengers)
    .findLast(passenger => passenger.age >= 18) !== undefined;
}

export function filteredMappedSortedSome(input) {
  return input.items
    .filter(item => item.enabled)
    .map(item => ({ score: item.value * 2, tag: item.tag }))
    .toSorted((left, right) => left.score - right.score)
    .some(entry => entry.score >= input.minimum && entry.tag === 'ok');
}

export function filteredFlatNestedFindLastIndex(input) {
  return input.groups
    .filter(group => group.visible)
    .map(group => group.people)
    .flat(1)
    .findLastIndex(person => person.age >= input.minimumAge && person.active) >= 0;
}
