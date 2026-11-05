import assert from 'node:assert/strict';
import { createDataFlowEvidenceBuilder } from '../src/scenarios/data-flow-evidence.mjs';
import { createScenarioEvidenceBuilder } from '../src/scenarios/scenario-evidence-builder.mjs';
import { createScenarioBuilder } from '../src/scenarios/scenario-builder.mjs';
import { createScenarioReportAdapter } from '../src/reporting/scenario-report-adapter.mjs';
import { enrichMockPlanWithDataFlow } from '../src/mocks/data-flow-mock-enricher.mjs';
import { planPathSensitiveLoop } from '../src/analysis/loops/path-sensitive-loop-planner.mjs';

const span = { file: 'fixture.ts', startOffset: 20, endOffset: 35, startLine: 2, startColumn: 1 };
const model = {
  properties: [{ path: { rootName: 'input', segments: ['user', 'age'] }, kind: 'number', confidence: 'declared' }],
  memorySsa: {
    locations: [{ id: 'mem:input:user.age', rootName: 'input', path: ['user', 'age'] }],
    accesses: [{ location: 'mem:input:user.age', kind: 'read', sourceSpan: span }],
  },
  pointsTo: { symbols: { symInput: 'input' }, aliasPairs: [{ leftSymbolId: 'symInput', rightSymbolId: 'symAlias', relation: 'may-alias' }] },
  ssa: { versioned: { useBindings: [{ name: 'input', value: 'symInput#1', occurrences: [span] }] } },
  arrayPipelineFlow: { pipelines: [{ id: 'pipeline:items', collectionPath: ['input', 'items'], warnings: [], provenance: { exactSourceIndexMapping: false } }] },
  interprocedural: { rootEffects: [{ path: ['input', 'user', 'age'], certainty: 'possible', kind: 'property-write' }] },
  loopFlow: { loops: [] },
  warnings: [],
};
const evidenceBuilder = createDataFlowEvidenceBuilder();
const evidence = evidenceBuilder.build({ dataFlowModel: model, assignments: new Map([['input.user.age', { path: ['input', 'user', 'age'], value: 21 }]]), sourceSpan: span });
assert.ok(evidence.some(item => item.message.includes('property/type evidence')));
assert.ok(evidence.some(item => item.message.includes('field-sensitive memory access')));
assert.ok(evidence.some(item => item.status === 'ambiguous' && item.message.includes('may-alias')));
assert.ok(evidence.some(item => item.message.includes('SSA use binding')));
assert.ok(evidence.some(item => item.message.includes('interprocedural effect')));
assert.ok(evidence.every(item => item.status !== 'verified'), 'static evidence must never claim runtime verification');

const scenarioEvidence = createScenarioEvidenceBuilder().build({
  assignments: new Map([['input.user.age', { path: ['input', 'user', 'age'], value: 21 }]]),
  dataFlowModel: model, sourceSpan: span,
});
const scenarioBuilder = createScenarioBuilder();
const scenario = scenarioBuilder.build({ id: 's1', functionId: 'f1', arguments: [{ user: { age: 21 } }], evidence: scenarioEvidence.evidence });
assert.ok(scenario.evidence.length > 0);
const reportAdapter = createScenarioReportAdapter();
const defaultReport = reportAdapter.project(scenario, { target: {}, mocks: [], unsupported: [] });
const reportWithEvidence = reportAdapter.project(scenario, { target: {}, mocks: [], unsupported: [], includeEvidence: true });
assert.equal('evidence' in defaultReport, false, 'legacy projection remains backward-compatible by default');
assert.ok(reportWithEvidence.evidence.length > 0);

const enriched = enrichMockPlanWithDataFlow({ version: 1, actions: [{
  callId: 'service.getUser', callExpression: 'service.getUser', callSiteId: 'call:1', behavior: 'mockResolvedValue', value: { id: 1 }, evidence: [],
}], diagnostics: [] }, {
  mockAssignments: [{ localName: 'user', binding: { callId: 'service.getUser' } }],
  callSites: [{ callSiteId: 'call:1', callExpression: 'service.getUser', argumentFacts: [
    { index: 0, kind: 'path', path: ['input', 'userId'], expressionText: 'input.userId', confidence: 'high' },
  ] }],
  dataFlowModel: {
    mockBindingFacts: [{ localName: 'user', callExpression: 'service.getUser' }],
    interprocedural: { contextSensitive: { contexts: [{ contextId: 'ctx:1', callId: 'call:1', transitiveEffects: [{ kind: 'read', path: ['input', 'userId'], certainty: 'definite' }] }] } },
  },
});
assert.deepEqual(enriched.actions[0].inputDependencies[0].path, ['input', 'userId']);
assert.equal(enriched.actions[0].dataFlowEffects[0].certainty, 'definite');
assert.ok(enriched.actions[0].evidence.some(item => item.source === 'static-analysis'));
const mockScenario = scenarioBuilder.build({ id: 's-mock', functionId: 'f1', arguments: [], mocks: enriched.actions });
assert.deepEqual(mockScenario.mocks[0].inputDependencies[0].path, ['input', 'userId']);
assert.equal(mockScenario.mocks[0].dataFlowEffects[0].certainty, 'definite');

const loop = planPathSensitiveLoop({
  initialState: new Map([['counter', 0]]),
  maxIterations: 8,
  evaluate: state => state.get('counter') < 3
    ? { continueSolutions: [{ assignments: new Map() }], exitSolutions: [] }
    : { continueSolutions: [], exitSolutions: [{ assignments: new Map() }] },
  transfer: state => new Map([['counter', state.get('counter') + 1]]),
});
assert.equal(loop.terminated, true);
assert.equal(loop.iterationCount, 4);
assert.equal(loop.exitSolutions.length, 1);
assert.equal(loop.iterations[loop.iterations.length - 1].state.counter, 3);
assert.equal(loop.truncated, false);
const capped = planPathSensitiveLoop({
  initialState: new Map([['counter', 0]]), maxIterations: 2,
  evaluate: () => ({ continueSolutions: [{}], exitSolutions: [] }),
  transfer: state => new Map([['counter', state.get('counter') + 1]]),
});
assert.equal(capped.truncated, true);

console.log('v1 integration tests passed: scenario Data Flow evidence, evidence-safe report projection, Data Flow-backed mock dependencies and bounded solver-feedback loop states.');
