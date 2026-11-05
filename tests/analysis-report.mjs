import assert from 'node:assert/strict';
import { createAnalysisReportBuilder, ANALYSIS_REPORT_SCHEMA_VERSION } from '../src/reporting/analysis-report-builder.mjs';
import { validateAnalysisReport } from '../src/reporting/analysis-report-schema.mjs';
import { createAnalysisRunForm } from '../src/reporting/analysis-run-form.mjs';

const sourceText = 'export function check(user) { return user.age > 18; }';
const sourceFile = { fileName: '/project/src/check.ts', getFullText: () => sourceText };
const project = {
  absoluteFile: '/project/src/check.ts', relativeFile: 'src/check.ts', projectRoot: '/project', sourceText,
  compilerApi: {
    version: '5.8.3',
    isImportDeclaration: () => false,
    isExportDeclaration: () => false,
    DiagnosticCategory: { Error: 'Error' },
    forEachChild: () => {},
  },
  program: {
    getSourceFiles: () => [sourceFile],
    getCompilerOptions: () => ({ strict: true, strictNullChecks: true, allowJs: true }),
    getSyntacticDiagnostics: () => [],
  },
  getRelativeFileName: file => file.replace('/project/', ''),
  functionIndex: {
    entries: [{ functionId: 'src/check.ts::check@0', symbolId: 'src/check.ts#16:check', name: 'check', relativeFile: 'src/check.ts', sourceFile, node: { getStart: () => 0 }, exported: true }],
    diagnostics: [],
  },
};
const dataFlowModel = {
  functionId: 'src/check.ts::check@0',
  properties: [{ path: { canonical: 'parameter:user.age' }, kind: 'number', confidence: 'declared', evidence: ['type'] }],
  aliases: [],
  controlFlowGraph: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [{ from: 'n1', to: 'n2' }], diagnostics: [] },
  controlFlowAnalysis: { naturalLoops: [] },
  flowAnalysis: { definitions: [], useBindings: [], phiCandidates: [], diagnostics: [] },
  ssa: { versioned: { algorithm: 'cytron-test', definitions: [{ id: 'v1' }], phiNodes: [], useBindings: [{ value: 'v1' }], diagnostics: [], convergence: { allReachableNodesVisited: true } } },
  memorySsa: { locations: [], accesses: [], definitions: [], phiNodes: [], diagnostics: [], limits: {} },
  pointsTo: { allocations: [], pointsTo: {}, aliasPairs: [], unknownSymbols: [], unknownHeapFields: [], constraints: {}, convergence: { converged: true }, diagnostics: [], limits: {} },
  functionSummaries: [{ functionId: 'src/helper.ts::getAge@0', symbolId: 'helper#getAge', name: 'getAge', sourceSpan: { file: 'src/helper.ts', startLine: 1 }, purity: 'pure', confidence: 'high', calls: [], returns: [], effects: [] }],
  callSites: [{ callId: 'call:42', callee: 'getAge', targetFunctionId: 'src/helper.ts::getAge@0', resolution: 'local-summary', knownPure: true, arguments: [{ dependencies: ['user'] }], sourceSpan: { file: 'src/check.ts', startLine: 1, startColumn: 20 } }],
  interprocedural: { contextSensitive: { contexts: [], diagnostics: [] }, diagnostics: [] },
  arrayPipelines: [], loopFlow: { loops: [] }, reduceFlows: [], warnings: [],
};
const scenario = {
  id: 'if-1-true-1',
  target: { branchId: 'if-1', kind: 'if', outcome: true, line: 1, column: 30, condition: 'user.age > 18', sourceText: 'user.age > 18' },
  arguments: [{ age: 21, email: 'person@example.test' }], assumptions: ['user.age'], unsupported: [],
  mocks: [{ call: 'service.loadUser', behavior: 'mockResolvedValue', resolvedValue: { email: 'person@example.test' }, evidence: [{ source: 'static-analysis', status: 'candidate', confidence: 0.8 }] }],
  evidence: [{ source: 'static-analysis', status: 'candidate', confidence: 0.9, message: 'SSA use resolved.' }],
};
const functionResult = {
  name: 'check', summary: { scenariosGenerated: 1, branchOutcomesFound: 2 }, scenarios: [scenario],
  _dataFlowModel: dataFlowModel,
};
const builder = createAnalysisReportBuilder();
const input = {
  project,
  report: { generator: { name: 'branch-scenarios-generator', version: '1.0.0-rc.6' }, generatedAt: '2026-11-05T10:00:00.000Z', sourceLanguage: 'typescript', functions: [{ name: 'check' }] },
  functionResults: [functionResult],
  functionUnits: [{ functionId: 'src/check.ts::check@0', name: 'check', relativeFile: 'src/check.ts', sourceSpan: { file: 'src/check.ts', startLine: 1 } }],
  sessions: [{ analysisSnapshot: { constraintStats: { irAttempts: 2, irSolved: 1, legacyFallback: 1, fallbackReasons: { unsupported: 1 } }, unsupportedBranches: [] } }],
  args: { maxScenarios: 40, mcdc: true, includeEvidence: true, testBatching: true },
};

const shape = builder.build({ ...input, valueMode: 'shape' });
assert.equal(shape.schemaVersion, ANALYSIS_REPORT_SCHEMA_VERSION);
assert.equal(validateAnalysisReport(shape).valid, true);
assert.equal(shape.project.imports.total, 0);
assert.equal(shape.project.functionIndex.total, 1);
assert.match(shape.project.fingerprint, /^[a-f0-9]{64}$/);
assert.equal(shape.project.fileDigests[0].sha256, shape.project.source.sha256);
assert.equal(shape.callGraph.edgeCount, 1);
assert.equal(shape.functions[0].dataFlow.scalarSsa.definitions, 1);
assert.equal(shape.functions[0].scenarios[0].arguments[0].fields.email.type, 'string');
assert.equal(JSON.stringify(shape).includes('person@example.test'), false, 'shape mode must not leak actual test values');
assert.equal(shape.externalExecution.status, 'not-recorded');
assert.equal(shape.externalExecution.executionForm.formType, 'branch-scenarios-execution-results-form');
assert.equal(shape.externalExecution.executionForm.schemaVersion, '1.0.0');
assert.equal(shape.privacy.absolutePathsIncluded, false);

const hashed = builder.build({ ...input, valueMode: 'hash' });
assert.match(hashed.functions[0].scenarios[0].arguments[0].sha256 ?? hashed.functions[0].scenarios[0].arguments[0].fields.age.sha256 ?? '', /^[a-f0-9]{64}$/);
const included = builder.build({ ...input, valueMode: 'include' });
assert.equal(included.functions[0].scenarios[0].arguments[0].email, 'person@example.test');
assert.equal(included.functions[0].scenarios[0].target.condition, 'user.age > 18');


const coverageFeedback = {
  status: 'passed', runner: 'jest', provider: 'v8', totals: { branches: { covered: 3, total: 4, pct: 75 } },
  execution: {
    testResults: { numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0, cases: [
      { id: 'if-1-true-1', status: 'passed' }, { id: 'if-1-false-1', status: 'failed', failureMessages: ['Expected: 1, received: 2'] },
    ] },
    testBatching: { strategy: 'test.each', batches: [{ id: 'batch-1', scenarioIds: ['if-1-true-1', 'if-1-false-1'], size: 2, signature: { version: 1, target: 'check', exportPath: 'check', setupProfile: '/secret/private/jest.setup.js', environment: 'node', lifecycle: 'isolated-test', runtime: 'jest', mockMethods: ['service.loadUser'] } }], individual: [] },
    scenarioCoverage: { totalCases: 2, passedCases: 1, casesWithBranchAttribution: 1, casesWithoutBranchAttribution: 1, cases: [{ caseId: 'if-1-true-1', status: 'passed', arguments: [{ age: 18 }], mocks: [], references: [{ type: 'branch', branchId: 'if-1', sourceSpan: { file: '/project/src/check.ts', startLine: 1 } }], decisionExecutions: [], coveredBranchOutcomes: [], mcdcPairSides: [] }] },
  },
};
const capturedFunctionResult = { ...functionResult, scenarios: [scenario, { ...scenario, id: 'if-1-false-1', target: { ...scenario.target, outcome: false } }] };
const coverageReport = builder.build({ ...input, functionResults: [capturedFunctionResult], report: { ...input.report, coverageFeedback }, valueMode: 'shape' });
assert.equal(coverageReport.externalExecution.status, 'captured-by-generator');
assert.equal(coverageReport.execution.testBatching.batches[0].signature.setupProfileConfigured, true);
assert.equal(JSON.stringify(coverageReport).includes('/secret/private/jest.setup.js'), false);
assert.equal(coverageReport.execution.scenarioCoverage.cases[0].references[0].sourceSpan.file, 'src/check.ts');
const capturedForm = createAnalysisRunForm({ analysisReport: coverageReport, functionResults: [capturedFunctionResult], coverageFeedback });
assert.deepEqual(capturedForm.testResults.cases.map(item => item.status), ['passed', 'failed']);
assert.equal(capturedForm.testResults.failed, 1);

const limited = builder.build({ ...input, valueMode: 'shape', maxScenarios: 1 });
assert.equal(limited.functions[0].scenariosTruncated, 0);
assert.equal(builder.build({ ...input, valueMode: 'unsafe' }).privacy.valueMode, 'shape');
console.log('Analysis report tests passed: schema, project graph, call graph, Data Flow summary, redaction, hash and include modes.');
