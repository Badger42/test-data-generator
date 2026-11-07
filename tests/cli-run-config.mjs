import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRunConfig } from '../src/cli/load-run-config.mjs';
import { parseCliArgs } from '../src/cli/parse-args.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsg-run-config-'));
try {
  const config = { file: 'target.mjs', functionName: 'configuredTarget', out: 'reports/configured.json', maxScenarios: 12, mcdc: true };
  fs.mkdirSync(path.join(temp, 'reports'));
  fs.writeFileSync(path.join(temp, 'branch-scenarios.config.json'), JSON.stringify(config, null, 2));
  assert.deepEqual(loadRunConfig({ fs, path, cwd: temp }), config);
  assert.throws(() => loadRunConfig({ fs, path, cwd: temp, explicitPath: 'missing.json' }), /does not exist/);
  assert.deepEqual(loadRunConfig({ fs, path, cwd: temp, disabled: true }), {});
  assert.throws(() => loadRunConfig({ fs, path, cwd: temp, explicitPath: 'branch-scenarios.config.json', disabled: true }), /cannot be combined/);
  assert.throws(() => loadRunConfig({ fs, path, cwd: temp, explicitPath: 'broken.json' }), /does not exist/);
  const merged = parseCliArgs(['override.mjs', '--max-scenarios', '3'], config);
  assert.equal(merged.file, 'override.mjs', 'CLI positional source must override the config file.');
  assert.equal(merged.out, 'reports/configured.json');
  assert.equal(merged.maxScenarios, 3, 'explicit CLI options must override config values.');
  assert.equal(merged.mcdc, true);
  assert.throws(() => parseCliArgs([], { unsupportedOption: true }), /Unknown run configuration option/);

  fs.writeFileSync(path.join(temp, 'target.mjs'), [
    'export function configuredTarget(input) {',
    "  if (input.enabled) return 'enabled';",
    "  return 'disabled';",
    '}',
    '',
  ].join('\n'));
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'branch-scenarios.mjs');
  const run = spawnSync(process.execPath, [cli, '--out', 'reports/cli-override.json'], {
    cwd: temp, encoding: 'utf8', env: { ...process.env },
  });
  assert.equal(run.status, 0, `Automatic run-config execution failed:\n${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(path.join(temp, 'reports', 'cli-override.json')));
  assert.ok(!fs.existsSync(path.join(temp, 'reports', 'configured.json')), 'CLI output option must override configured output.');
  const noConfig = spawnSync(process.execPath, [cli, '--no-run-config'], {
    cwd: temp, encoding: 'utf8', env: { ...process.env },
  });
  assert.notEqual(noConfig.status, 0, '--no-run-config must disable automatic source-file discovery.');
  assert.match(noConfig.stderr, /A source file is required/);
  console.log('CLI run configuration tests passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
