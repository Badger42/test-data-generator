function revive(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && value.$undefined === true) return undefined;
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
  }
  return value;
}

globalThis.__BRANCH_TEST_SERVICE__ = {
  getPassenger: async () => { throw new Error('Scenario mock was not applied'); },
};

let setupCalls = 0;
globalThis.__BRANCH_SCENARIO_APPLY_MOCKS__ = async mocks => {
  setupCalls += 1;
  globalThis.__BRANCH_SCENARIO_SETUP_HOOK_CALLS__ = setupCalls;
  const value = mocks.find(item => item.call === 'globalThis.__BRANCH_TEST_SERVICE__.getPassenger');
  if (!value) throw new Error('Expected a passengerService.getPassenger mock for this scenario');
  const resolved = revive(value.resolvedValue);
  globalThis.__BRANCH_TEST_SERVICE__.getPassenger = async () => resolved;
};
