export function summarizePassengers(input) {
  let minors = 0;
  let active = 0;

  for (const passenger of input.passengers) {
    if (passenger.age < 18) minors += 1;
    if (passenger.isActive) active += 1;
  }

  return { minors, active };
}

export function sumPositiveSegments(input) {
  let total = 0;
  for (let index = 0; index < input.segments.length; index++) {
    if (input.segments[index].distance > 0) {
      total += input.segments[index].distance;
    }
  }
  return total;
}

export function countActiveRecords(input) {
  let count = 0;
  for (const key in input.records) {
    if (input.records[key].isActive) count += 1;
  }
  return count;
}

export function countUntilLimit(input) {
  let count = input.count;
  while (count < input.limit) count += 1;
  return count;
}

export function doWhileAtLeastOnce(input) {
  let count = 0;
  do {
    count += 1;
  } while (count < input.limit);
  return count;
}

export function fixedIterations() {
  let result = 0;
  for (let index = 0; index < 3; index++) result += index;
  return result;
}

export function summarizeGroups(input) {
  let minors = 0;
  for (const group of input.groups) {
    for (const passenger of group.passengers) {
      if (passenger.age < 18) minors += 1;
    }
  }
  return minors;
}

export function countToLimit(input) {
  let index = 0;
  while (index < input.limit) index += 1;
  return index;
}

export function fixedWhile() {
  let index = 0;
  while (index < 3) index += 1;
  return index;
}

export function fixedDoWhile() {
  let index = 0;
  do {
    index += 1;
  } while (index < 3);
  return index;
}

export function findSecondActiveItem(input) {
  for (let index = 1; index < input.items.length; index++) {
    if (input.items[index].isActive) return index;
  }
  return -1;
}
