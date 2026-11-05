import assert from 'node:assert/strict';
import { createReportBuilder } from '../src/reporting/report-builder.mjs';
import { assertGenerationReport, validateGenerationReport } from '../src/reporting/report-schema.mjs';

const builder = createReportBuilder();
const report = builder.build({
  version: '1.0.0', source: 'src/example.ts', sourceLanguage: 'typescript',
  generatedAt: '2026-11-05T12:00:00.000Z', limitations: ['static candidates'],
  functions: [{ name: 'example', scenarios: [], summary: { scenariosGenerated: 0 } }],
  functionResults: [{ _constraintStats: { irAttempts: 2, irSolved: 1, legacyFallback: 1, fallbackReasons: { unsupported: 1 } } }],
  constraintDiagnostics: true,
});
assert.equal(report.generator.version, '1.0.0');
assert.equal(report.constraintEngine.irAttempts, 2);
assert.equal(report.constraintEngine.fallbackReasons.unsupported, 1);
assert.equal(validateGenerationReport(report).valid, true);
assert.throws(() => assertGenerationReport({ ...report, functions: [{ name: 'broken' }] }), /functions\[0\]\.scenarios/);
assert.throws(() => builder.build({ ...report, version: '', functions: [{ name: 'x', scenarios: [], summary: {} }] }), /generator.version/);
console.log('Reporting tests passed: pure report composition, constraint aggregation and public-schema validation.');
