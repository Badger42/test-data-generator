export function getPassengerCategory(passenger) {
  if (!passenger) {
    return 'missing';
  }

  if (passenger.age < 18) {
    return 'child';
  }

  if (passenger.isPremium && passenger.country === 'NL') {
    return 'premium-nl';
  }

  if (passenger.isPremium) {
    return 'premium';
  }

  return 'standard';
}

export function getFlightLabel(flight) {
  if (flight.profile.isActive && flight.segments.length > 1) {
    return 'active-multi-segment';
  }
  return 'other';
}

export function getReadiness(input) {
  if (input.flags.isReady) {
    return input.metadata.owner;
  }
  return 'not-ready';
}

export function getCodeLength(input) {
  if (input.code.length === 2) {
    return input.code.toUpperCase();
  }
  return 'other';
}

export function getPassengerAgeStatus(input) {
  if (input.passengers[0].age < 18) {
    return 'child';
  }
  return 'adult';
}

export function getSimpleCategory(age, isPremium) {
  if (age < 18) return 'child';
  if (isPremium) return 'premium';
  return 'standard';
}
