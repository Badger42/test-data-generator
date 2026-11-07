import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createDependencyDiscovery } from '../src/mocks/dependency-discovery.mjs';
import { createMockTemplateBuilder } from '../src/mocks/mock-template-builder.mjs';
import { loadTypescriptProject } from '../src/project/load-typescript-project.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'external-call-sites-'));
try {
  const helper = path.join(temp, 'helpers.ts');
  const source = path.join(temp, 'service.ts');
  fs.writeFileSync(helper, 'export function normalize(value: string) { return value.trim(); }\n');
  fs.writeFileSync(source, `
import { normalize } from './helpers';
declare const api: {
  load(id: string): Promise<{ active: boolean }>;
  inspect(value: string): boolean;
};
export function tested(input: { id: string; text: string }) {
  function localHelper(value: string) {
    return api.inspect(normalize(value));
  }
  const direct = api.inspect(input.id);
  const loaded = api.load(input.id);
  const found = [input.text].some(value => api.inspect(normalize(value)));
  return Boolean(direct && localHelper(input.text) && found && loaded.active);
}
`);
  const project = loadTypescriptProject({ file: source });
  const tested = project.functionIndex.entries.find(entry => entry.name === 'tested');
  assert.ok(tested, 'test function should be indexed');
  const discovery = createDependencyDiscovery(ts);
  const discovered = discovery.discoverCallSites({
    functionNode: tested.node,
    checker: project.checker,
    sourceFile: tested.sourceFile,
    functionIndex: project.functionIndex,
    relativeFile: 'service.ts',
    unwrap: node => node,
  });

  const externalSites = discovered.filter(site => site.callExpression === 'api.inspect' || site.callExpression === 'api.load');
  assert.equal(externalSites.length, 4,
    'external calls in direct code, local function bodies and inline callbacks must be found');
  assert.deepEqual(externalSites.filter(site => site.callExpression === 'api.inspect').map(site => site.nested).sort(),
    [false, true, true]);
  assert.equal(discovered.some(site => site.callExpression === 'normalize'), false,
    'an imported project-local function must not be classified as an external dependency');
  assert.equal(discovered.some(site => site.callExpression === 'localHelper'), false,
    'a function declared inside the tested function is local, not an external dependency');
  let arraySomeCall = null;
  const visitBuiltins = node => {
    if (ts.isCallExpression(node) && node.expression.name?.text === 'some') arraySomeCall = node;
    ts.forEachChild(node, visitBuiltins);
  };
  visitBuiltins(tested.node);
  assert.ok(arraySomeCall);
  assert.equal(project.functionIndex.classifyCall(arraySomeCall).kind, 'builtin-intrinsic',
    'native Array.prototype methods must not be treated as external dependencies');
  const local = externalSites.find(site => site.nested && site.functionScope === 'localHelper');
  assert.ok(local, 'nested local-function body must be identified');
  assert.equal(local.executionContext, 'nested-function-body');
  assert.equal(local.reachability, 'nested-invocation-not-proven');
  const callback = externalSites.find(site => site.nested && site.functionScope === '<inline-callback>');
  assert.ok(callback, 'inline callback body must be traversed');
  const direct = externalSites.find(site => site.callExpression === 'api.inspect' && !site.nested);
  assert.deepEqual(direct.argumentFacts[0].path, ['input', 'id']);
  const promise = externalSites.find(site => site.callExpression === 'api.load');
  assert.equal(promise.isPromise, true);
  assert.deepEqual(promise.argumentFacts[0].path, ['input', 'id']);

  const templates = createMockTemplateBuilder({
    defaultValueForType: type => type.flags & ts.TypeFlags.BooleanLike ? false
      : type.flags & ts.TypeFlags.Object ? { active: false } : '',
    unionMembers: type => [type],
    serialize: value => value,
  }).build({ callSites: externalSites, checker: project.checker });
  assert.equal(templates.length, 4, 'templates must be preserved per call-site, not collapsed by method expression');
  assert.ok(templates.every(item => item.callSiteId && item.callArguments.length === 1));
  assert.equal(templates.find(item => item.call === 'api.load').mockBehavior, 'mockResolvedValue');
  assert.ok(templates.some(item => item.nested));

  console.log('External call discovery passed: direct sites, nested helper and callback bodies, argument provenance and per-site mock templates.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
