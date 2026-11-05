interface Fare { amount: number; currency: string }
declare const pricing: {
  getFare(code: string): Promise<Fare>;
  getStatus(): string;
  getPending(): Promise<Fare>;
};

export async function buildTicket(code: string) {
  const fare = await pricing.getFare(code);
  const status = pricing.getStatus();
  const pending = pricing.getPending();
  if (fare.amount > 100 && status === 'active') return pending;
  return fare;
}
