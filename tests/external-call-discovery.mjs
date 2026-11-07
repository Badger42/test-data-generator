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
  if (input.id) {
    const deferred = (value: string) => api.inspect(value);
    void deferred;
  }
  const direct = api.inspect(input.id);
  const loaded = api.load(input.id);
  const found = [input.text].some(value => api.inspect(normalize(value)));
  const response = fetch(input.text);
  return Boolean(direct && localHelper(input.text) && found && loaded.active && response);
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

  const externalSites = discovered.filter(site => ['api.inspect', 'api.load', 'fetch'].includes(site.callExpression));
  assert.equal(externalSites.length, 6,
    'external calls in direct code, local function bodies and inline callbacks must be found');
  assert.deepEqual(externalSites.filter(site => site.callExpression === 'api.inspect').map(site => site.nested).sort(),
    [false, true, true, true]);
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
  let fetchCall = null;
  const visitFetch = node => {
    if (ts.isCallExpression(node) && node.expression.getText(tested.sourceFile) === 'fetch') fetchCall = node;
    ts.forEachChild(node, visitFetch);
  };
  visitFetch(tested.node);
  assert.ok(fetchCall);
  assert.equal(project.functionIndex.classifyCall(fetchCall).kind, 'external-dependency',
    'host APIs declared in TypeScript DOM libraries must remain mockable external dependencies');
  const local = externalSites.find(site => site.nested && site.functionScope === 'localHelper');
  assert.ok(local, 'nested local-function body must be identified');
  assert.equal(local.executionContext, 'nested-function-body');
  assert.equal(local.reachability, 'nested-invocation-not-proven');
  const deferred = externalSites.find(site => site.functionScope === 'deferred');
  assert.ok(deferred, 'nested function declared under a branch must still be discovered');
  assert.equal(deferred.executionContext, 'nested-function-body');
  assert.deepEqual(deferred.executionGuards, [],
    'a nested function body must not inherit the lexical guard of its declaration site');
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
  assert.equal(templates.length, 6, 'templates must be preserved per call-site, not collapsed by method expression');
  assert.equal(templates.find(item => item.call === 'fetch').mockBehavior, 'mockResolvedValue');
  assert.ok(templates.every(item => item.callSiteId && item.callArguments.length === 1));
  assert.equal(templates.find(item => item.call === 'api.load').mockBehavior, 'mockResolvedValue');
  assert.ok(templates.some(item => item.nested));

  // A precise exclusion leaves other methods of the same service mockable.
  const exclusionSource = path.join(temp, 'mock-exclusions.ts');
  const parserDir = path.join(temp, 'node_modules', 'external-parser');
  fs.mkdirSync(parserDir, { recursive: true });
  fs.writeFileSync(path.join(parserDir, 'package.json'), JSON.stringify({
    name: 'external-parser', types: './index.d.ts', main: './index.js',
  }));
  fs.writeFileSync(path.join(parserDir, 'index.d.ts'), 'export function parse(value: string): boolean;\\n');
  fs.writeFileSync(path.join(parserDir, 'index.js'), 'exports.parse = value => Boolean(value);\\n');
  fs.writeFileSync(exclusionSource, `
import { parse } from 'external-parser';
declare const externalServices: {
  getPersonData(id: string): { active: boolean };
  getAddress(id: string): { city: string };
};
export function mockExclusionsTarget(input: { id: string }) {
  const person = externalServices.getPersonData(input.id);
  const address = externalServices.getAddress(input.id);
  const parsed = parse(input.id);
  return Boolean(person.active && address.city && parsed);
}
`);
  const exclusionProject = loadTypescriptProject({ file: exclusionSource });
  const exclusionFunction = exclusionProject.functionIndex.entries.find(entry => entry.name === 'mockExclusionsTarget');
  assert.ok(exclusionFunction);
  const exclusionInput = {
    functionNode: exclusionFunction.node,
    checker: exclusionProject.checker,
    sourceFile: exclusionFunction.sourceFile,
    functionIndex: exclusionProject.functionIndex,
    relativeFile: 'mock-exclusions.ts',
    unwrap: node => node,
    mockExclusions: {
      methods: ['externalServices.getPersonData'],
      libraries: ['external-parser'],
    },
  };
  const exclusionSites = discovery.discoverCallSites(exclusionInput);
  const personSite = exclusionSites.find(site => site.callExpression === 'externalServices.getPersonData');
  const addressSite = exclusionSites.find(site => site.callExpression === 'externalServices.getAddress');
  const parserSite = exclusionSites.find(site => site.callExpression === 'parse');
  assert.equal(personSite.mockExcluded, true);
  assert.deepEqual(personSite.mockExclusion, { kind: 'method', pattern: 'externalServices.getPersonData', call: 'externalServices.getPersonData' });
  assert.equal(addressSite.mockExcluded, undefined);
  assert.equal(parserSite.mockExcluded, true);
  assert.equal(parserSite.mockExclusion.kind, 'library');
  assert.equal(parserSite.mockExclusion.module, 'external-parser');

  const excludedBindings = discovery.discoverLocalMockBindings(exclusionInput);
  assert.equal(excludedBindings.has('person'), false, 'excluded call results must not become solver mock bindings');
  assert.equal(excludedBindings.has('address'), true, 'non-excluded sibling calls retain solver bindings');
  const exclusionTemplates = createMockTemplateBuilder({
    defaultValueForType: type => type.flags & ts.TypeFlags.BooleanLike ? false
      : type.flags & ts.TypeFlags.Object ? { active: false, city: '' } : '',
    unionMembers: type => [type],
    serialize: value => value,
  }).build({ callSites: exclusionSites, checker: exclusionProject.checker });
  assert.deepEqual(exclusionTemplates.map(item => item.call), ['externalServices.getAddress']);

  const serviceExclusions = discovery.discoverCallSites({
    ...exclusionInput,
    mockExclusions: { services: ['externalServices'] },
  });
  assert.ok(serviceExclusions.filter(site => site.callExpression.startsWith('externalServices.')).every(site => site.mockExcluded),
    'service-level rules must exclude all methods on the receiver');
  console.log('External call discovery passed: call-site metadata and granular mock exclusion policies.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
