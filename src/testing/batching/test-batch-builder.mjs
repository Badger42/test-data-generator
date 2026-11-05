import { createExecutionSignature } from './execution-signature.mjs';

/**
 * Groups runnable ScenarioCases by execution shape. Scenario payloads remain
 * untouched and each row stays a separate Jest assertion/test result.
 */
export function createTestBatchBuilder(options = {}) {
  const defaultMinBatchSize = options.minBatchSize ?? 2;
  const defaultMaxBatchSize = options.maxBatchSize ?? 100;
  if (!Number.isInteger(defaultMinBatchSize) || defaultMinBatchSize < 2) throw new RangeError('minBatchSize must be an integer >= 2.');
  if (!Number.isInteger(defaultMaxBatchSize) || defaultMaxBatchSize < defaultMinBatchSize) throw new RangeError('maxBatchSize must be >= minBatchSize.');

  function build(cases, context = {}, overrides = {}) {
    if (!Array.isArray(cases)) throw new TypeError('TestBatchBuilder expects an array of cases.');
    const minBatchSize = overrides.minBatchSize ?? defaultMinBatchSize;
    const maxBatchSize = overrides.maxBatchSize ?? defaultMaxBatchSize;
    if (!Number.isInteger(minBatchSize) || minBatchSize < 2) throw new RangeError('minBatchSize must be an integer >= 2.');
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < minBatchSize) throw new RangeError('maxBatchSize must be >= minBatchSize.');

    const compatibleRuns = [];
    const individual = [];
    const diagnostics = [];
    const seenIds = new Set();
    let activeRun = null;
    const flushRun = () => {
      if (activeRun) compatibleRuns.push(activeRun);
      activeRun = null;
    };

    for (const item of cases) {
      if (!item || typeof item !== 'object' || !item.id) throw new TypeError('Every test case must have a stable id.');
      if (seenIds.has(item.id)) throw new Error(`Duplicate test case id '${item.id}'.`);
      seenIds.add(item.id);
      const normalizedItem = {
        ...item,
        testName: item.testName ?? item.name ?? `[Scenario] ${item.id}`,
      };
      const compatibility = createExecutionSignature(normalizedItem, context);
      if (!compatibility.batchable) {
        flushRun();
        individual.push({ ...normalizedItem, batchReason: compatibility.reasons.join(' ') });
        diagnostics.push({ caseId: item.id, code: 'TEST_CASE_NOT_BATCHABLE', reasons: compatibility.reasons });
        continue;
      }
      if (activeRun && activeRun.key !== compatibility.key) flushRun();
      if (!activeRun) activeRun = { key: compatibility.key, signature: compatibility.signature, cases: [] };
      activeRun.cases.push(normalizedItem);
    }
    flushRun();

    const batches = [];
    for (const run of compatibleRuns) {
      if (run.cases.length < minBatchSize) {
        individual.push(...run.cases);
        continue;
      }
      for (let offset = 0; offset < run.cases.length; offset += maxBatchSize) {
        const chunk = run.cases.slice(offset, offset + maxBatchSize);
        if (chunk.length < minBatchSize) {
          individual.push(...chunk);
          continue;
        }
        batches.push({
          id: `test-batch-${String(batches.length + 1).padStart(4, '0')}`,
          signature: run.signature,
          cases: chunk,
          scenarioIds: chunk.map(item => item.id),
        });
      }
    }

    const inputOrder = new Map(cases.map((item, index) => [item.id, index]));
    const batchedCount = batches.reduce((total, batch) => total + batch.cases.length, 0);
    const entries = [
      ...batches.map(batch => ({ kind: 'batch', batchId: batch.id, firstIndex: inputOrder.get(batch.scenarioIds[0]) })),
      ...individual.map(item => ({ kind: 'individual', scenarioId: item.id, firstIndex: inputOrder.get(item.id) })),
    ].sort((left, right) => left.firstIndex - right.firstIndex);
    const batchById = new Map(batches.map(batch => [batch.id, batch]));
    const individualById = new Map(individual.map(item => [item.id, item]));
    return Object.freeze({
      version: 1,
      batches: Object.freeze(batches.map(batch => Object.freeze({
        ...batch,
        cases: Object.freeze(batch.cases),
        scenarioIds: Object.freeze(batch.scenarioIds),
      }))),
      individual: Object.freeze(individual.sort((left, right) => inputOrder.get(left.id) - inputOrder.get(right.id))),
      entries: Object.freeze(entries.map(entry => Object.freeze(entry))),
      diagnostics: Object.freeze(diagnostics),
      stats: Object.freeze({
        inputCases: cases.length,
        batchedCases: batchedCount,
        individualCases: individual.length,
        batchCount: batches.length,
        averageBatchSize: batches.length ? Number((batchedCount / batches.length).toFixed(2)) : 0,
      }),
    });
  }

  return Object.freeze({ build });
}
