import { stableStringify } from './execution-signature.mjs';

/** Pure renderer for the registration portion of a Jest test.each suite. */
export function renderJestEachRegistrations(plan, options = {}) {
  if (!plan || !Array.isArray(plan.batches) || !Array.isArray(plan.individual)) {
    throw new TypeError('A TestBatchBuilder plan is required.');
  }
  const callbackName = options.callbackName ?? 'runScenario';
  const testApi = options.testApi ?? 'test';
  const batchVariable = options.batchVariable ?? 'BATCHES';
  const individualVariable = options.individualVariable ?? 'INDIVIDUAL_CASES';
  if (!/^[A-Za-z_$][\w$]*$/.test(callbackName) || !/^[A-Za-z_$][\w$]*$/.test(testApi)) {
    throw new TypeError('Renderer identifiers must be valid JavaScript identifiers.');
  }
  const batchIndexes = new Map(plan.batches.map((batch, index) => [batch.id, index]));
  const individualIndexes = new Map(plan.individual.map((item, index) => [item.id, index]));
  const entries = Array.isArray(plan.entries)
    ? plan.entries
    : [
      ...plan.batches.map(batch => ({ kind: 'batch', batchId: batch.id })),
      ...plan.individual.map(item => ({ kind: 'individual', scenarioId: item.id })),
    ];
  return entries.map(entry => {
    if (entry.kind === 'batch') {
      const index = batchIndexes.get(entry.batchId);
      if (index === undefined) throw new Error(`Unknown test batch '${entry.batchId}'.`);
      const rows = `${batchVariable}[${index}].cases.map(scenario => [String(scenario.testName ?? '[Scenario]') + ' [scenario:' + scenario.id + ']', scenario])`;
      return `${testApi}.each(${rows})('%s', async (_testName, scenario) => ${callbackName}(scenario));`;
    }
    const index = individualIndexes.get(entry.scenarioId);
    if (index === undefined) throw new Error(`Unknown individual scenario '${entry.scenarioId}'.`);
    const item = plan.individual[index];
    return `${testApi}(${JSON.stringify(`${item.testName ?? `[Scenario] ${item.id}`} [scenario:${item.id}]`)}, async () => ${callbackName}(${individualVariable}[${index}]));`;
  }).join('\n');
}

export function serializeTestBatchPayload(plan) {
  return stableStringify({
    batches: plan.batches.map(batch => ({ id: batch.id, signature: batch.signature, cases: batch.cases })),
    individual: plan.individual,
  });
}
