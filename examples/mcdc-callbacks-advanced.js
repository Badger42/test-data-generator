export function indexSensitive(input) {
  return input.items.some((item, index) => index === 1 && item.enabled);
}

export function indexAndProperty(input) {
  return input.items.some((item, index) => index > 0 && item.score >= input.minimumScore);
}

export function callbackLocalAliases(input) {
  return input.passengers.some(passenger => {
    const isAdult = passenger.age >= 18;
    const isActive = passenger.isActive;
    const isEligible = isAdult && isActive;
    return isEligible && passenger.country === input.country;
  });
}

export function callbackLocalAliasChain(input) {
  return input.passengers.some(passenger => {
    const isAllowedCountry = passenger.country === input.country;
    const hasEnoughPoints = passenger.points >= input.minimumPoints;
    const isEligible = isAllowedCountry || hasEnoughPoints;
    return isEligible && passenger.isActive;
  });
}

export function callbackLocalAliasesInIf(input) {
  return input.items.some(item => {
    const hasScore = item.score > 0;
    const isEnabled = item.enabled;
    if (hasScore && isEnabled) return true;
    return false;
  });
}

export function callbackLocalAliasesWithNestedIf(input) {
  return input.items.every(item => {
    const hasRole = item.role === 'admin';
    const isActive = item.active;
    if (hasRole || isActive) return true;
    return false;
  });
}

export function conditionalReturnMustRemainControlFlow(input) {
  return input.items.some(item => {
    if (item.enabled) return item.ready;
    return false;
  });
}
