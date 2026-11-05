/**
 * Example Jest ESM setup module for Branch Scenario Generator.
 *
 * Adjust the dependency specifier and mock method names to your project.
 * This module is imported by the generated Jest adapter before the target
 * source module, so ESM mocks can be registered before the target is loaded.
 */
import { jest } from '@jest/globals';
import { createJestMockAdapter } from '../src/mocks/adapters/jest-mock-adapter.mjs';

const getPassenger = jest.fn();

jest.unstable_mockModule('../src/services/passenger-service.js', () => ({
  passengerService: { getPassenger },
}));

function revive(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && value.$undefined === true) {
    return undefined;
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}

const mockAdapter = createJestMockAdapter();
const mockRegistry = new Map([
  ['passengerService.getPassenger', getPassenger],
]);

globalThis.__BRANCH_SCENARIO_RESET_MOCKS__ = async () => {
  getPassenger.mockReset();
};

globalThis.__BRANCH_SCENARIO_APPLY_MOCKS__ = async (mocks, scenario) => {
  mockAdapter.applyLegacy(mocks, mockRegistry);

  // `scenario` is also available for custom test-specific setup:
  // console.log('Preparing generated scenario:', scenario.id);
};
