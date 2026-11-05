/**
 * @typedef {Object} Passenger
 * @property {number} age
 * @property {boolean} isPremium
 * @property {string} country
 */

/** @param {Passenger | null | undefined} passenger */
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

/** @param {{ count: number, enabled: boolean }} data */
export function getSize(data) {
  if (data.count > 0 && data.count < 3 && data.enabled) {
    return 'small-enabled';
  }
  return 'other';
}
