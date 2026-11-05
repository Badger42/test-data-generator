import { passengerService } from './coverage-feedback-service.js';

export async function serviceCoverageTarget(input) {
  const passenger = await passengerService.getPassenger(input.id);

  if (!passenger) return 'missing';
  if (passenger.age < input.minimumAge) return 'below';
  return 'adult';
}
