export async function coverageMockTarget(input) {
  const passenger = await globalThis.__BRANCH_TEST_SERVICE__.getPassenger(input.id);

  if (!passenger) return 'missing';
  if (passenger.age < input.minimumAge) return 'below';
  return 'adult';
}
