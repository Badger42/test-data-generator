/** Normalize Jest --json output and attribute each assertion to its scenario. */
export function readJestTestResults(fileName, cases, fs) {

  if (!fs.existsSync(fileName)) return null;
  try {
    const report = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    const assertions = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []);
    const byName = new Map(assertions.map(assertion => [assertion.fullName ?? assertion.title, assertion]));
    return {
      success: Boolean(report.success),
      numTotalTests: report.numTotalTests ?? assertions.length,
      numPassedTests: report.numPassedTests ?? assertions.filter(item => item.status === 'passed').length,
      numFailedTests: report.numFailedTests ?? assertions.filter(item => item.status === 'failed').length,
      numPendingTests: report.numPendingTests ?? assertions.filter(item => item.status === 'pending').length,
      ...(Number.isInteger(report.setupHookCalls) ? { setupHookCalls: report.setupHookCalls } : {}),
      ...(Number.isInteger(report.jestResetAllMocksCalls) ? { jestResetAllMocksCalls: report.jestResetAllMocksCalls } : {}),
      cases: cases.map(item => {
        const assertion = byName.get(item.testName);
        return {
          id: item.id,
          status: assertion?.status ?? 'missing-result',
          failureMessages: assertion?.failureMessages ?? [],
          references: item.references,
        };
      }),
    };
  } catch (error) {
    return { success: false, error: `Could not parse Jest JSON results: ${error.message}` };
  }

}
