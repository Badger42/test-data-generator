import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScenarios } from '../src/application/generate-scenarios.mjs';
import * as analyzerRuntime from '../src/runtime/typescript-analysis-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/constraint-expression-dataflow.ts');
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-planner-production-'));
const output = path.join(outputDir, 'scenarios.json');
try {
  const result = generateScenarios({
    file: fixture,
    functionName: 'classify',
    all: false,
    maxScenarios: 20,
    coverageIterations: 1,
    coverageGoal: 100,
    coverageProvider: 'v8',
    constraintEngine: 'hybrid',
    out: output,
    mockBehaviorOverrides: {
      'pricing.getFare': {
        behavior: 'sequence',
        sequence: [
          { behavior: 'mockResolvedValue', value: { amount: 110, currency: 'EUR' } },
          { behavior: 'mockRejectedValue', error: { name: 'Error', message: 'temporary' } },
        ],
      },
    },
  }, { cwd: root, log: () => {}, setExitCode: () => {}, ...analyzerRuntime });
  assert.equal(result.status, 'generated');
  const mocks = result.result.functions.find(fn => fn.name === 'classify').scenarios.flatMap(scenario => scenario.mocks ?? []);
  assert.ok(mocks.length > 0);
  assert.ok(mocks.every(mock => mock.call === 'pricing.getFare' && mock.behavior === 'sequence'));
  assert.ok(mocks.every(mock => mock.sequence.length === 2));
  assert.ok(fs.existsSync(output));
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

console.log('Mock Planner production integration passed: Application -> FunctionAnalysisSession -> analyzer adapter -> MockPlan -> compatibility report.');
