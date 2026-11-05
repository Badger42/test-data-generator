import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importPattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return walk(relative);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [relative] : [];
  });
}

const modules = ['branch-scenarios.mjs', ...walk('src')].sort();
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const moduleMap = JSON.parse(fs.readFileSync(path.join(root, 'docs/architecture/MODULE_MAP.json'), 'utf8'));
assert.equal(moduleMap.currentVersion, packageMetadata.version, 'MODULE_MAP version must match package.json');
assert.equal(moduleMap.architectureStatus.legacyMonolithRemoved, true);
assert.equal(moduleMap.architectureStatus.legacySourceDirectoryRemoved, true);
assert.equal(moduleMap.legacyEngine, undefined, 'stale legacyEngine metadata must not return');
const mappedSourceFiles = new Set(moduleMap.modules.flatMap(item => item.implementedFiles ?? []));
for (const file of modules.filter(item => item.startsWith('src/'))) {
  assert.ok(mappedSourceFiles.has(file), `${file} must be represented in MODULE_MAP.json`);
}
for (const file of mappedSourceFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `MODULE_MAP.json references missing file ${file}`);
}
const dependencyGraphDocument = fs.readFileSync(path.join(root, 'docs/architecture/DEPENDENCY_GRAPH.mmd'), 'utf8');
assert.doesNotMatch(dependencyGraphDocument, /src\/legacy\/|legacy-engine\.mjs|legacy-fallback-adapter\.mjs|legacy-function-analyzer-adapter\.mjs/,
  'dependency graph must describe the current module tree, not removed Legacy paths');
const graph = new Map();
for (const relative of modules) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const imports = [];
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('.')) continue;
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
    if (!path.posix.extname(resolved)) resolved += '.mjs';
    imports.push(resolved);
    assert.ok(fs.existsSync(path.join(root, resolved)), `${relative} imports missing module ${specifier} (${resolved})`);
  }
  graph.set(relative, imports);
}

const importsOf = file => graph.get(file) ?? [];
const sourceOf = file => fs.readFileSync(path.join(root, file), 'utf8');

// The old monolithic analyzer directory is gone. Compatibility is confined to
// explicit public/report adapters; no source module imports a Legacy module.
assert.ok(!fs.existsSync(path.join(root, 'src/legacy')), 'src/legacy must be removed');
for (const [file, imports] of graph) {
  assert.ok(!imports.some(item => item.includes('/legacy/') || item.endsWith('/legacy-engine.mjs')), `${file} must not import a Legacy module`);
}

// Dependency direction: the CLI is the composition root. Application use cases
// receive the TypeScript runtime through ports and never import it directly.
assert.deepEqual(importsOf('branch-scenarios.mjs'), ['src/cli/main.mjs']);
assert.ok(importsOf('src/cli/main.mjs').includes('src/application/generate-scenarios.mjs'));
assert.ok(importsOf('src/cli/main.mjs').includes('src/runtime/typescript-analysis-runtime.mjs'));
assert.ok(!importsOf('src/application/generate-scenarios.mjs').some(item => item.startsWith('src/runtime/')),
  'Application must depend on runtime ports, not the TypeScript runtime implementation');
assert.ok(importsOf('src/application/generate-scenarios.mjs').includes('src/analysis/function-analyzer-adapter.mjs'));
assert.ok(importsOf('src/runtime/typescript-analysis-runtime.mjs').includes('src/runtime/coverage-feedback-runtime.mjs'));
assert.ok(importsOf('src/runtime/coverage-feedback-runtime.mjs').includes('src/application/run-coverage-feedback.mjs'));
assert.ok(importsOf('src/runtime/typescript-analysis-runtime.mjs').includes('src/reporting/scenario-report-adapter.mjs'));
assert.ok(importsOf('src/runtime/typescript-analysis-runtime.mjs').includes('src/reporting/mock-report-adapter.mjs'));
assert.ok(!importsOf('src/scenarios/scenario-builder.mjs').some(item => item.startsWith('src/reporting/')), 'ScenarioBuilder must not project public report DTOs');
assert.ok(!importsOf('src/mocks/mock-planner.mjs').some(item => item.startsWith('src/reporting/')), 'MockPlanner must not depend on public report format');
assert.doesNotMatch(sourceOf('src/mocks/adapters/jest-mock-adapter.mjs'), /applyLegacy/);
assert.doesNotMatch(sourceOf('src/scenarios/scenario-builder.mjs'), /toLegacyReportScenario/);
assert.doesNotMatch(sourceOf('src/mocks/mock-planner.mjs'), /toLegacyMocks/);

// The domain layer owns shared policies; inference must not reach upward into
// array-analysis implementation details.
assert.ok(importsOf('src/inference/property-inference.mjs').includes('src/domain/array-method-policy.mjs'));
assert.ok(!importsOf('src/inference/property-inference.mjs').some(item => item.startsWith('src/analysis/')));
for (const file of modules.filter(item => item.startsWith('src/domain/'))) {
  assert.ok(importsOf(file).every(item => item.startsWith('src/domain/')), `${file} must remain a domain leaf`);
}

// Data Flow and Solver cores are compiler/runtime independent through ports and
// JSON-safe DTOs. TypeScript API must be injected into AST-aware passes.
const dataFlowModules = modules.filter(item => item.startsWith('src/data-flow/'));
for (const file of dataFlowModules) {
  const imports = importsOf(file);
  assert.ok(!imports.some(item => item.startsWith('src/runtime/') || item.startsWith('src/application/') || item.startsWith('src/solver/') || item.startsWith('src/legacy/')),
    `${file} must not depend on runtime, application, solver or legacy orchestration`);
  assert.ok(!/(?:from\s*|import\s*\()(['"])typescript\1/.test(sourceOf(file)), `${file} must receive TypeScript through injection`);
}
assert.ok(importsOf('src/data-flow/data-flow-analyzer.mjs').every(item => item.startsWith('src/data-flow/')));
assert.ok(importsOf('src/data-flow/data-flow-adapter.mjs').every(item => item.startsWith('src/data-flow/')));
assert.equal(importsOf('src/data-flow/ssa/cytron-ssa-builder.mjs').length, 0);
assert.equal(importsOf('src/data-flow/summaries/context-sensitive-summary.mjs').length, 0);
assert.ok(importsOf('src/solver/constraint-solver.mjs').every(item => item === 'src/constraints/constraint-ir.mjs'));
for (const file of ['src/solver/constraint-analysis-service.mjs', 'src/solver/recursive-ast-fallback.mjs', 'src/mcdc/mcdc-analysis-orchestrator.mjs', 'src/analysis/analysis-operation-context.mjs']) {
  assert.equal(importsOf(file).length, 0, `${file} must receive operations through explicit ports`);
}

// Analysis orchestration owns per-session state; pure reducer and domain
// transformations cannot import compiler, process or application services.
assert.equal(importsOf('src/analysis/analysis-state-reducer.mjs').length, 0);
assert.ok(importsOf('src/analysis/analysis-state-store.mjs').every(item => item === 'src/analysis/analysis-state-reducer.mjs'));
assert.match(sourceOf('src/analysis/function-analysis-orchestrator.mjs'), /ctx\.analysisState\.snapshot\(\)/);
for (const file of ['src/minimization/obligation-builder.mjs', 'src/minimization/test-suite-minimizer.mjs', 'src/coverage/coverage-feedback-iteration.mjs']) {
  assert.ok(!importsOf(file).some(item => item.startsWith('src/application/') || item.startsWith('src/runtime/')),
    `${file} must remain a pure transformation`);
}

// Reporting and batching are explicit boundaries. Batching remains independent
// of TypeScript and only the Jest harness knows about the batching adapters.
for (const file of ['src/testing/batching/execution-signature.mjs', 'src/testing/batching/test-batch-builder.mjs', 'src/testing/batching/jest-each-generator.mjs']) {
  assert.ok(!importsOf(file).some(item => item.startsWith('src/runtime/') || item.startsWith('src/legacy/')));
  assert.ok(!/(?:from\s*|import\s*\()(['"])typescript\1/.test(sourceOf(file)));
}
assert.ok(importsOf('src/execution/jest-test-harness.mjs').every(item => item.startsWith('src/testing/batching/')));
assert.equal(importsOf('src/execution/jest-runner.mjs').length, 0, 'JestRunner receives filesystem/process ports');
assert.ok(importsOf('src/application/run-coverage-feedback.mjs').every(item => item === 'src/testing/batching/test-batch-builder.mjs'));

// Explicit layering rules. A privileged runtime may compose lower layers and
// application use cases; no lower layer may import the runtime composition.
function layer(file) {
  if (file.startsWith('src/domain/')) return 'domain';
  if (file.startsWith('src/constraints/') || file.startsWith('src/solver/')) return 'compiler';
  if (file.startsWith('src/ast/') || file.startsWith('src/inference/') || file.startsWith('src/project/')) return 'frontend';
  if (file.startsWith('src/analysis/') || file.startsWith('src/data-flow/') || file.startsWith('src/scenarios/') || file.startsWith('src/mocks/') || file.startsWith('src/mcdc/')) return 'analysis';
  if (file.startsWith('src/application/') || file.startsWith('src/execution/') || file.startsWith('src/coverage/') || file.startsWith('src/minimization/') || file.startsWith('src/reporting/') || file.startsWith('src/testing/')) return 'application';
  if (file.startsWith('src/runtime/')) return 'runtime';
  if (file.startsWith('src/cli/')) return 'interface';
  return 'unknown';
}
const allowed = {
  domain: new Set(['domain']),
  compiler: new Set(['domain', 'compiler']),
  frontend: new Set(['domain', 'frontend']),
  analysis: new Set(['domain', 'compiler', 'frontend', 'analysis']),
  application: new Set(['domain', 'compiler', 'frontend', 'analysis', 'application']),
  runtime: new Set(['domain', 'compiler', 'frontend', 'analysis', 'application', 'runtime']),
  interface: new Set(['domain', 'application', 'runtime', 'interface']),
};
for (const [file, imports] of graph) {
  const owner = layer(file);
  if (owner === 'unknown') continue;
  for (const imported of imports) {
    if (!graph.has(imported)) continue;
    const target = layer(imported);
    assert.ok(allowed[owner]?.has(target), `Forbidden dependency direction: ${owner} ${file} -> ${target} ${imported}`);
  }
}

// Detect relative-import cycles across every discovered source module. This is
// generated from the filesystem, not a hand-maintained allowlist.
const visiting = new Set();
const visited = new Set();
function visit(file) {
  if (visiting.has(file)) throw new Error(`Circular module dependency detected at ${file}`);
  if (visited.has(file)) return;
  visiting.add(file);
  for (const imported of importsOf(file)) if (graph.has(imported)) visit(imported);
  visiting.delete(file);
  visited.add(file);
}
for (const file of graph.keys()) visit(file);
console.log(`Module boundaries passed (${graph.size} auto-discovered modules, no cycles or forbidden layer dependencies).`);
