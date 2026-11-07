import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { loadTypescriptProject } from '../src/project/load-typescript-project.mjs';
import { createDependencyDiscovery } from '../src/mocks/dependency-discovery.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-target-resolver-'));
try {
  const sourcePath = path.join(root, 'service.ts');
  const helperPath = path.join(root, 'helper.ts');
  const typesPath = path.join(root, 'remote-api.d.ts');
  fs.writeFileSync(helperPath, 'export function localNormalize(value: string) { return value.trim(); }\n');
  fs.writeFileSync(typesPath, "declare module 'remote-api' { export function loadRemote(id: string): Promise<{ active: boolean }>; }\n");
  fs.writeFileSync(sourcePath, String.raw`/// <reference path="./remote-api.d.ts" />
import { localNormalize } from './helper';
import { loadRemote as getRemote } from 'remote-api';
declare const telemetry: { record(name: string): void };
export async function tested(input: { id: string; enabled: boolean }) {
  const remote = await getRemote(input.id);
  const local = localNormalize(input.id);
  telemetry.record(input.id);
  if (input.enabled && remote.active) return local;
  return fetch(input.id);
}
`);
  const project = loadTypescriptProject({ file: sourcePath });
  const entry = project.functionIndex.entries.find(item => item.name === 'tested');
  assert.ok(entry);
  const discovery = createDependencyDiscovery(ts);
  const input = {
    functionNode: entry.node, checker: project.checker, sourceFile: entry.sourceFile,
    functionIndex: project.functionIndex, program: project.program,
    relativeFile: 'service.ts', unwrap: node => node,
  };
  const sites = discovery.discoverCallSites(input);
  const bindings = discovery.discoverLocalMockBindings(input);
  const remote = sites.find(item => item.callExpression === 'getRemote');
  assert.ok(remote);
  assert.equal(remote.mockTarget.kind, 'module-export');
  assert.equal(remote.mockTarget.support, 'automatic');
  assert.equal(remote.mockTarget.moduleSpecifier, 'remote-api');
  assert.deepEqual(remote.mockTarget.exportPath, ['loadRemote']);
  assert.equal(remote.mockTarget.moduleMode, 'esm');
  const telemetry = sites.find(item => item.callExpression === 'telemetry.record');
  assert.ok(telemetry);
  assert.equal(telemetry.mockTarget.kind, 'unresolved');
  assert.equal(telemetry.mockTarget.support, 'manual-setup-required');
  const fetch = sites.find(item => item.callExpression === 'fetch');
  assert.ok(fetch);
  assert.equal(fetch.mockTarget.kind, 'global-member');
  assert.equal(fetch.mockTarget.memberName, 'fetch');
  assert.equal(sites.some(item => item.callExpression === 'localNormalize'), false);
  assert.equal(bindings.get('remote').mockTarget.id, remote.mockTarget.id);
  console.log('Mock target resolver passed: imported exports, contract-only calls, globals and local helper exclusion.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
