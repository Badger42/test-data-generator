export interface Passenger {
  age: number;
  isPremium: boolean;
  country: string;
  children?: number;
}

export function getPassengerCategory(passenger?: Passenger) {
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

export function getDiscount(age: number, premium: boolean) {
  return age >= 18 && premium ? 20 : 0;
}

export function getFlightType(type: 'domestic' | 'international' | 'charter') {
  switch (type) {
    case 'domestic': return 'D';
    case 'international': return 'I';
    default: return 'C';
  }
}

export interface PassengerService {
  getPassenger(id: string): Promise<Passenger | null>;
}

export async function loadPassengerCategory(id: string, service: PassengerService) {
  const passenger = await service.getPassenger(id);
  if (!passenger) return 'missing';
  if (passenger.age < 18) return 'child';
  return 'adult';
}
