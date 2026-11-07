import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseCliArgs } from '../src/cli/parse-args.mjs';
import { createHelpText } from '../src/cli/help.mjs';
import { runCli } from '../src/cli/main.mjs';

const defaults = parseCliArgs(['src/example.js']);
assert.equal(defaults.file, 'src/example.js');
assert.equal(defaults.maxScenarios, 40);
assert.equal(defaults.coverageProvider, 'v8');
assert.equal(defaults.mcdc, false);
assert.equal(defaults.constraintEngine, 'hybrid');
assert.equal(defaults.constraintDiagnostics, false);
assert.equal(defaults.analysisReport, false);
assert.equal(defaults.analysisReportValueMode, 'shape');
assert.deepEqual(defaults.mockExclusions, { services: [], libraries: [], methods: [] });
const configuredExclusions = parseCliArgs(['src/example.js'], { mockExclusions: { methods: ['externalServices.getPersonData'] } });
assert.deepEqual(configuredExclusions.mockExclusions, { services: [], libraries: [], methods: ['externalServices.getPersonData'] });
assert.throws(() => parseCliArgs(['src/example.js'], { mockExclusions: { methods: 'externalServices.getPersonData' } }), /must be an array/);
assert.throws(() => parseCliArgs(['src/example.js'], { mockExclusions: { unknown: [] } }), /Unknown mock exclusion category/);
assert.equal(defaults.jestTimeoutMs, 120_000);
assert.equal(defaults.coverageFeedbackTimeoutMs, 600_000);
const customTimeouts = parseCliArgs(['src/example.js', '--jest-timeout', '30000', '--coverage-feedback-timeout', '180000']);
assert.equal(customTimeouts.jestTimeoutMs, 30_000);
assert.equal(customTimeouts.coverageFeedbackTimeoutMs, 180_000);
assert.throws(() => parseCliArgs(['src/example.js', '--jest-timeout', '0']), /integer between/);
assert.throws(() => parseCliArgs(['src/example.js', '--coverage-feedback-timeout', '1.5']), /integer between/);

const analysisReportArgs = parseCliArgs(['src/example.ts', '--analysis-report', '--analysis-report-values', 'hash', '--analysis-report-max-scenarios', '120']);
assert.equal(analysisReportArgs.analysisReport, true);
assert.equal(analysisReportArgs.analysisReportValueMode, 'hash');
assert.equal(analysisReportArgs.analysisReportMaxScenarios, 120);
const executionFormArgs = parseCliArgs(['src/example.ts', '--analysis-report-form-out', 'reports/run-form.json']);
assert.equal(executionFormArgs.analysisReport, true);
assert.equal(executionFormArgs.analysisReportFormOut, 'reports/run-form.json');
assert.throws(() => parseCliArgs(['src/example.ts', '--analysis-report-form-out']), /requires a file path/);
const customAnalysisReport = parseCliArgs(['src/example.ts', '--analysis-report-out', 'out/assistant-report.json']);
assert.equal(customAnalysisReport.analysisReport, true);
assert.equal(customAnalysisReport.analysisReportOut, 'out/assistant-report.json');
assert.throws(() => parseCliArgs(['src/example.ts', '--analysis-report-out']), /requires a file path/);

const legacyEngine = parseCliArgs(['src/example.js', '--constraint-engine', 'legacy', '--constraint-diagnostics']);
assert.equal(legacyEngine.constraintEngine, 'legacy');
assert.equal(legacyEngine.constraintDiagnostics, true);

const minimal = parseCliArgs(['src/example.js', '--minimal-suite-out', 'out/minimal.json']);
assert.equal(minimal.minimalSuite, true);
assert.equal(minimal.coverageFeedback, true);
assert.equal(minimal.mcdc, true);
assert.equal(minimal.minimalSuiteOut, 'out/minimal.json');

const externalCoverage = parseCliArgs(['src/example.js', '--coverage-from', 'coverage/coverage-final.json']);
assert.equal(externalCoverage.coverageFeedback, true);
assert.equal(externalCoverage.coverageFrom, 'coverage/coverage-final.json');

assert.throws(() => parseCliArgs(['src/example.js', '--unknown']), /Unknown argument/);
assert.match(createHelpText(), /Branch Scenario Generator v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);

const logs = [];
const helpResult = await runCli(['--help'], { log: value => logs.push(value), error: value => logs.push(value) });
assert.equal(helpResult.status, 'help');
assert.ok(logs.join('\n').includes('Usage:'));
assert.ok(logs.join('\n').includes('--analysis-report'));
assert.ok(logs.join('\n').includes('--analysis-report-values'));
assert.ok(logs.join('\n').includes('--analysis-report-form-out'));
assert.ok(logs.join('\n').includes('--jest-timeout'));

const entry = spawnSync(process.execPath, ['branch-scenarios.mjs', '--help'], { encoding: 'utf8' });
assert.equal(entry.status, 0, entry.stderr);
assert.match(entry.stdout, /Branch Scenario Generator v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
console.log('CLI module tests passed.');
