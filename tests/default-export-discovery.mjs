import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { discoverFunctions } from '../src/project/discover-functions.mjs';
import { loadTypescriptProject } from '../src/project/load-typescript-project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-default-export-'));
const write = (relative, content) => {
  const filename = path.join(temp, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
};

try {
  write('package.json', JSON.stringify({ type: 'module' }));
  write('common/values.js',
    "export const COUNTRY = 'RUS';\n" +
    "export function normalize(value) { return String(value).trim(); }\n");
  const objectFile = write('services/default-object.js',
    "import { COUNTRY, normalize } from '../common/values';\n" +
    "export default {\n" +
    "  methodShorthand(input) {\n" +
    "    if (input.enabled) return COUNTRY;\n" +
    "    return '';\n" +
    "  },\n" +
    "  methodExpression: function (input) {\n" +
    "    if (input.ready) return normalize(input.value);\n" +
    "    return '';\n" +
    "  },\n" +
    "  methodArrow: input => input.active ? true : false,\n" +
    "};\n");

  const project = loadTypescriptProject({ file: objectFile });
  const functions = discoverFunctions(project.sourceFile, { relativeFile: project.relativeFile });
  assert.deepEqual(functions.map(item => item.name).sort(),
    ['methodArrow', 'methodExpression', 'methodShorthand'].sort(),
    'all callable properties on an export-default object must be discoverable');

  const sourceFiles = project.program.getSourceFiles().map(file => path.resolve(file.fileName));
  assert.ok(sourceFiles.includes(path.resolve(temp, 'common/values.js')),
    'extensionless relative imports must be included in the TypeScript Program');
  assert.ok(project.functionIndex.entries.some(entry => entry.name === 'normalize' && entry.exported),
    'an imported project function must be indexed as exported');
  for (const name of ['methodShorthand', 'methodExpression', 'methodArrow']) {
    const entry = project.functionIndex.entries.find(item => item.name === name);
    assert.ok(entry, 'FunctionIndex must include ' + name);
    assert.equal(entry.exported, true, name + ' is reachable through the default-exported object');
  }

  let importedCall = null;
  const visitCall = node => {
    if (ts.isCallExpression(node) && node.expression.getText(project.sourceFile) === 'normalize') importedCall = node;
    ts.forEachChild(node, visitCall);
  };
  visitCall(project.sourceFile);
  assert.ok(importedCall);
  assert.equal(project.functionIndex.classifyCall(importedCall).kind, 'project-function',
    'an extensionless local import must resolve as a project function');

  const cliOutput = path.join(temp, 'selected.scenarios.json');
  const cliRun = spawnSync(process.execPath, [
    path.join(root, 'branch-scenarios.mjs'), objectFile,
    '--function', 'methodExpression', '--analysis-report', '--out', cliOutput,
  ], { cwd: root, encoding: 'utf8', timeout: 90_000 });
  assert.equal(cliRun.status, 0,
    '--function must select a callable property from export default object:\n' + cliRun.stdout + '\n' + cliRun.stderr);
  const selected = JSON.parse(fs.readFileSync(cliOutput, 'utf8'));
  assert.equal(selected.functions.length, 1);
  assert.equal(selected.functions[0].name, 'methodExpression');

  const reportFile = path.join(temp, 'selected.scenarios.analysis-report.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.project.imports.project, 1,
    'the analysis report must classify extensionless relative imports as project files');
  assert.equal(report.project.functionIndex.functions.find(item => item.name === 'methodExpression').exported, true);

  const receiverFile = write('services/receiver-object.js',
    "export default {\n" +
    "  getValue(input) { return input.value; },\n" +
    "  check(input) {\n" +
    "    if (input.enabled) return this.getValue(input);\n" +
    "    return null;\n" +
    "  },\n" +
    "};\n");
  const receiverOutput = path.join(temp, 'receiver.scenarios.json');
  const receiverRun = spawnSync(process.execPath, [
    path.join(root, 'branch-scenarios.mjs'), receiverFile,
    '--function', 'check', '--coverage-feedback',
    '--jest-bin', path.join(root, 'tests', 'fixtures', 'fake-jest-runner.cjs'),
    '--out', receiverOutput,
  ], { cwd: root, encoding: 'utf8', timeout: 90_000 });
  assert.equal(receiverRun.status, 0,
    'coverage feedback must preserve the default-exported object as method this:\\n' + receiverRun.stdout + '\\n' + receiverRun.stderr);
  const receiverReport = JSON.parse(fs.readFileSync(receiverOutput, 'utf8'));
  assert.equal(receiverReport.coverageFeedback.execution.testResults.numFailedTests, 0,
    'method calls that use this must execute with the default-exported object as receiver');

  const instanceFile = write('services/default-instance.js',
    "class Service {\n" +
    "  run(input) {\n" +
    "    if (input.enabled) return 1;\n" +
    "    return 0;\n" +
    "  }\n" +
    "}\n" +
    "export default new Service();\n");
  const instanceProject = loadTypescriptProject({ file: instanceFile });
  const runEntry = instanceProject.functionIndex.entries.find(item => item.name === 'run');
  assert.ok(runEntry);
  assert.equal(runEntry.exported, true,
    'methods exposed through an export-default class instance must be marked exported');

  const anonymousFile = write('services/default-function.js',
    "export default function (input) {\n" +
    "  return input ? 'yes' : 'no';\n" +
    "}\n");
  const anonymousFunctions = discoverFunctions(loadTypescriptProject({ file: anonymousFile }).sourceFile);
  assert.ok(anonymousFunctions.some(item => item.name === 'default'),
    'an anonymous default-exported function must be selectable as --function default');

  console.log('Default export discovery passed: callable object properties, anonymous default functions, instance methods, and extensionless project imports.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
