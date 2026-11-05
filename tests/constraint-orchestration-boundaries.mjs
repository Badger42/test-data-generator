import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const runtimeComposition = read('src/runtime/typescript-analysis-runtime.mjs');

for (const implementation of [
  'trySolveWithConstraintIR', 'trySolveMcdcWithConstraintIR',
  'solveMcdcAssignment', 'getMcdcCallbackContextVariants',
]) {
  assert.doesNotMatch(runtimeComposition, new RegExp(`function\\s+${implementation}\\s*\\(`),
    `${implementation} must live in a dedicated orchestration module, not the TypeScript composition root`);
}
assert.match(runtimeComposition, /function\s+solveCondition\s*\(/, 'the TypeScript front-end exposes a narrow solveCondition adapter');
assert.match(runtimeComposition, /mcdcAnalysisOrchestrator\.analyzeMcdcDecision\(/, 'the front-end MC/DC adapter must delegate to the extracted orchestrator');
assert.match(runtimeComposition, /createConstraintAnalysisService\(/);
assert.match(runtimeComposition, /createRecursiveAstFallbackAdapter\(/);
assert.match(runtimeComposition, /createMcdcAnalysisOrchestrator\(/);
assert.match(runtimeComposition, /createAnalysisOperationContext\(/);

const files = [
  'src/analysis/analysis-operation-context.mjs',
  'src/solver/constraint-analysis-service.mjs',
  'src/solver/recursive-ast-fallback.mjs',
  'src/mcdc/mcdc-analysis-orchestrator.mjs',
];
for (const file of files) {
  const source = read(file);
  assert.doesNotMatch(source, /from\s+['"]typescript/,
    `${file} must receive TypeScript operations through explicit ports`);
  assert.doesNotMatch(source, /process\.|spawnSync|from\s+['"]node:/,
    `${file} must not own process/runtime infrastructure`);
}
assert.match(read('src/solver/constraint-analysis-service.mjs'), /recursiveAstFallbackAdapter\.solve/);
assert.match(read('src/mcdc/mcdc-analysis-orchestrator.mjs'), /solveMcdcAssignment/);
assert.doesNotMatch(read('src/analysis/analysis-operation-context.mjs'), /(?:^|[,{])\s*(?:compatibility|legacy)\s*:/i, 'operation context must not expose an opaque compatibility property');
assert.doesNotMatch(runtimeComposition, /createLegacyOperationView|createCompatibilityOperationView/);
assert.doesNotMatch(read('src/mcdc/mcdc-analysis-orchestrator.mjs'), /engine:\s*'legacy'/, 'internal contexts use the recursive AST port name, not a legacy engine label');
assert.match(read('src/solver/recursive-ast-fallback.mjs'), /operationContext\.paths\.pathAliases/, 'AST fallback must consume named operation ports');
assert.match(read('src/analysis/analysis-operation-context.mjs'), /deriveAnalysisOperationContext/, 'operation context supports safe per-call derivation');

console.log('Constraint orchestration boundary tests passed: IR service, explicit fallback, MC/DC orchestration and operation context are isolated behind explicit ports.');
