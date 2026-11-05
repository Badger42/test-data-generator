export function summarizeUntilStop(input) {
  let total = 0;
  for (const entry of input.entries) {
    if (entry.stop) break;
    if (entry.skip) continue;
    if (entry.enabled) total += 1;
    if (entry.priority > 5) total += 10;
  }
  return total;
}

export function summarizeWithNestedContinue(input) {
  let total = 0;
  for (const item of input.items) {
    {
      if (item.skip) continue;
    }
    if (item.accepted) total += 1;
  }
  return total;
}

export function countEnabledWithForEach(input) {
  let total = 0;
  input.items.forEach(item => {
    if (item.enabled) total += 1;
    else if (item.score > 5) total += 2;
  });
  return total;
}

export function mapAgeCategory(input) {
  return input.people.map(person => person.age < 18 ? 'minor' : 'adult');
}

export function hasAdultWithSome(input) {
  return input.people.some(person => person.age >= 18);
}

export function hasReadyWithSomeIf(input) {
  if (input.items.some(item => item.ready)) return true;
  return false;
}

export function allReadyWithEvery(input) {
  return input.items.every(item => item.ready);
}

export function detectSecondCallbackIndex(input) {
  let found = false;
  input.items.forEach((item, index) => {
    if (index === 1) found = true;
  });
  return found;
}

export function summarizeWithSwitchContinue(input) {
  let total = 0;
  for (const item of input.items) {
    switch (item.action) {
      case 'leave-switch':
        break;
      case 'continue-loop':
        continue;
      default:
        if (item.enabled) total += 1;
    }
    if (item.afterSwitch) total += 10;
  }
  return total;
}

export function hasSecondActiveItemWithSome(input) {
  return input.items.some((item, index) => index === 1 && item.active);
}
