/** Normalize Jest --json output and attribute each assertion to its scenario. */
export function readJestTestResults(fileName, cases, fs) {
  if (!fs.existsSync(fileName)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    const assertions = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []);
    const unusedAssertions = [...assertions];
    const caseResults = cases.map(item => {
      const baseTitle = item.testName ?? `[Scenario] ${item.id}`;
      const uniqueTitle = `${baseTitle} [scenario:${item.id}]`;
      let assertionIndex = unusedAssertions.findIndex(assertion =>
        (assertion.fullName ?? assertion.title) === uniqueTitle);
      if (assertionIndex < 0) {
        // Compatibility with old standalone test-name formats; consume one
        // matching assertion at a time so duplicate titles never overwrite.
        assertionIndex = unusedAssertions.findIndex(assertion =>
          (assertion.fullName ?? assertion.title) === baseTitle);
      }
      const assertion = assertionIndex >= 0 ? unusedAssertions.splice(assertionIndex, 1)[0] : null;
      return {
        id: item.id,
        status: assertion?.status ?? 'missing-result',
        failureMessages: assertion?.failureMessages ?? [],
        references: item.references,
      };
    });
    return {
      success: Boolean(report.success),
      numTotalTests: report.numTotalTests ?? assertions.length,
      numPassedTests: report.numPassedTests ?? assertions.filter(item => item.status === 'passed').length,
      numFailedTests: report.numFailedTests ?? assertions.filter(item => item.status === 'failed').length,
      numPendingTests: report.numPendingTests ?? assertions.filter(item => item.status === 'pending').length,
      ...(Number.isInteger(report.setupHookCalls) ? { setupHookCalls: report.setupHookCalls } : {}),
      ...(Number.isInteger(report.jestClearAllMocksCalls) ? { jestClearAllMocksCalls: report.jestClearAllMocksCalls } : {}),
      // Read the legacy field when consuming reports emitted by older harnesses.
      ...(Number.isInteger(report.jestResetAllMocksCalls) ? { jestResetAllMocksCalls: report.jestResetAllMocksCalls } : {}),
      cases: caseResults,
    };
  } catch (error) {
    return { success: false, error: `Could not parse Jest JSON results: ${error.message}` };
  }
}
