import { VERSION } from '../domain/version.mjs';

export function createHelpText(version = VERSION) {
  return `
Branch Scenario Generator v${version}

Usage:
  node branch-scenarios.mjs <file.js|.jsx|.ts|.tsx> [options]

Options:
  -f, --function <name>     Analyze only the named function
  -o, --out <file.json>     Output JSON file (default: <file>.scenarios.json)
      --config <path>       Use a specific tsconfig.json or jsconfig.json (default: auto-detect)
      --tsconfig <path>     Alias for --config (backwards compatibility)
      --jsconfig <path>     Alias for --config
      --max-scenarios <n>   Max scenarios per branch (default: 40)
      --constraint-engine <hybrid|legacy>  Use IR multi-witness solving first with recursive-AST fallback; legacy is an alias (default: hybrid)
      --constraint-diagnostics Include IR/fallback migration metrics in the JSON output
      --include-evidence       Include per-scenario static Data Flow evidence (candidate, not runtime-verified)
      --analysis-report        Write a diagnostic report and fillable execution-results form beside the generation JSON
      --analysis-report-out <file.json>  Write the diagnostic report to a specific path
      --analysis-report-form-out <file.json> Write a fillable execution-results form (default: alongside the diagnostic report)
      --analysis-report-values <shape|hash|include>  Scenario-value privacy mode (default: shape)
      --analysis-report-max-scenarios <n> Max detailed scenarios per function in diagnostic report (default: 500)
      --analysis-report-values <shape|hash|include> Scenario-value privacy mode (default: shape)
      --all                 Analyze all discovered functions
      --mcdc                Generate unique-cause MC/DC independence pairs
      --coverage-feedback   Execute scenarios with Jest and iteratively expand candidates when coverage is incomplete
      --minimal-suite       Attribute runtime branch outcomes per scenario and compute a minimal suite (implies --mcdc and --coverage-feedback)
      --minimal-suite-out <file.json> Export the selected minimal test data as JSON (implies --minimal-suite)
                            With --mcdc, instrument decisions and atomic conditions for runtime MC/DC
      --coverage-iterations <n> Maximum Jest feedback passes (default: 3, including the initial run)
      --coverage-goal <pct>   Stop when file-level branch coverage reaches this percentage (default: 100)
      --jest-timeout <ms>     Maximum duration of one Jest pass (default: 120000)
      --coverage-feedback-timeout <ms> Overall Jest-pass budget across iterative feedback (default: 600000)
      --coverage-from <json> Read an existing coverage-final.json instead of running Jest
      --jest-config <file>  Use a specific Jest config
      --jest-bin <file>     Explicit path to jest.js (auto-detected by default)
      --jest-setup <file>   Preload a Jest setup module before importing the target module
      --no-test-batching    Disable compatible test.each grouping (enabled by default)
      --test-batch-min-size <n> Minimum rows per test.each batch (default: 2)
      --test-batch-max-size <n> Maximum rows per test.each batch (default: 100)
      --coverage-provider <v8|babel>  Jest coverage provider (default: v8)
      --export <path>       Module export path (default: analyzed function name)
  -h, --help                Show help

Example:
  node branch-scenarios.mjs src/passenger.ts --function getPassengerCategory \\
    --out test-data/passenger.scenarios.json
`;
}

export function printHelp(write = console.log) {
  write(createHelpText());
}
