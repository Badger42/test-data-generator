let calls = 0;

globalThis.__BRANCH_SCENARIO_APPLY_MOCKS__ = async (_mocks, _scenario) => {
  calls += 1;
  globalThis.__BRANCH_SCENARIO_SETUP_HOOK_CALLS__ = calls;
};
