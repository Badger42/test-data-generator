export function someAdults(input) {
  return input.passengers.some(passenger => passenger.isActive && passenger.age >= 18);
}

export function everyAllowed(input) {
  return input.passengers.every(passenger => passenger.isActive || passenger.role === 'admin');
}

export function filterEligible(input) {
  return input.passengers.filter(passenger => !passenger.isBlocked && (passenger.score > 0 || passenger.isVerified));
}

export function findEligible(input) {
  return input.passengers.find(passenger => passenger.isActive && passenger.country === 'NL');
}

export function findIndexEligible(input) {
  return input.passengers.findIndex(passenger => passenger.isActive && passenger.age > input.minimumAge);
}

export function blockReturnPredicate(input) {
  return input.passengers.some(passenger => {
    return passenger.isActive && passenger.age >= 18;
  });
}

export function blockIfPredicate(input) {
  return input.passengers.some(passenger => {
    if (passenger.isActive && passenger.age >= 18) return true;
    return false;
  });
}

export function chainedPredicate(input) {
  return input.passengers
    .filter(passenger => passenger.country === 'NL')
    .some(passenger => passenger.isActive && passenger.age >= 18);
}

export function nestedPredicate(input) {
  return input.groups.some(group => group.passengers.every(passenger => passenger.isActive && passenger.age >= 18));
}
