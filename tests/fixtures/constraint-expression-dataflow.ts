import { pricing } from './constraint-expression-service.js';

export async function classify(input: {
  unitPrice: number;
  quantity: number;
  discount: number;
  fareCode: string;
}) {
  const fare = await pricing.getFare(input.fareCode);
  const subtotal = input.unitPrice * input.quantity;
  const afterDiscount = subtotal - input.discount;
  const net = afterDiscount + fare.amount;

  if (net > 100) return 'high';
  return 'low';
}

export function classifyMutable(input: { unitPrice: number; quantity: number }) {
  let subtotal = input.unitPrice * input.quantity;
  if (subtotal > 100) return 'high';
  return 'low';
}

export function classifyConcat(input: { first: string; last: string }) {
  const fullName = input.first + input.last;
  if (fullName.length > 4) return 'long';
  return 'short';
}
