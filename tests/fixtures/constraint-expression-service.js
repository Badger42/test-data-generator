/** @typedef {{ amount: number; currency: string }} Fare */

/** @type {{ getFare(code: string): Promise<Fare> }} */
export const pricing = {
  async getFare(code) {
    return { amount: code.length * 10, currency: 'EUR' };
  },
};
