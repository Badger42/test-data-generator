import { createRequire } from 'node:module';

/** Jest executable discovery and process execution adapter. */
export function createJestRunner({ fs, path, process, spawnSync }) {
  const require = createRequire(import.meta.url);

  function safeRealPath(candidate) {
    try {
      return typeof fs.realpathSync === 'function' ? fs.realpathSync(candidate) : candidate;
    } catch {
      return candidate;
    }
  }

  function resolveWindowsShimTarget(executablePath) {
    if (!/\.(?:cmd|bat)$/i.test(executablePath)) return null;
    try {
      const wrapper = fs.readFileSync(executablePath, 'utf8');
      const targetMatch = wrapper.match(/"([^"\r\n]*jest[\\/]bin[\\/]jest\.js)"/i);
      if (!targetMatch?.[1]) return null;
      const expanded = targetMatch[1].replace(/%~?dp0%?/gi, path.dirname(executablePath));
      const target = path.resolve(path.dirname(executablePath), expanded);
      return fs.existsSync(target) ? target : null;
    } catch {
      return null;
    }
  }

  function getJestPackageVersion(executablePath) {
    if (!executablePath || !path.isAbsolute(executablePath)) return null;
    const resolved = safeRealPath(executablePath);
    const candidates = [resolved, executablePath];
    for (const candidate of candidates) {
      let current = path.dirname(candidate);
      while (true) {
        const packagePath = path.join(current, 'package.json');
        if (fs.existsSync(packagePath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            if (manifest.name === 'jest') return manifest.version ?? null;
          } catch { /* keep searching parent package directories */ }
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Windows .cmd/.bat launchers are not symlinks. Resolve their JS entry
    // point so the child is started with node directly (safe for spaces and
    // avoids passing an explicit user path through cmd.exe).
    const shimTarget = resolveWindowsShimTarget(executablePath);
    if (shimTarget) {
      const version = getJestPackageVersion(shimTarget);
      if (version) return version;
    }
    return null;
  }

  function getRunnerVersion(command, prefixArgs, shell) {
    const manifestVersion = (prefixArgs.length ? getJestPackageVersion(prefixArgs[0]) : null) ?? getJestPackageVersion(command);
    if (manifestVersion) return manifestVersion;
    const result = spawnSync(command, [...prefixArgs, '--version'], {
      encoding: 'utf8', windowsHide: true, shell,
      timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (result?.error || result?.status !== 0) return null;
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
  }

  function withVersion(runner) {
    return { ...runner, version: getRunnerVersion(runner.command, runner.prefixArgs, runner.shell) };
  }

  function findJestRunner() {
    let packagePath;
    try {
      // Resolve the package manifest from this generator module, never from
      // the consuming project's cwd, analyzed source, or Jest config.
      packagePath = require.resolve('jest/package.json');
    } catch {
      throw new Error('The generator requires its pinned Jest 30.5.2 dependency. Run npm install in the generator installation.');
    }

    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (manifest.version !== '30.5.2') {
      throw new Error(`The generator requires Jest 30.5.2; found ${manifest.version ?? 'unknown'} in ${packagePath}.`);
    }
    const candidate = path.join(path.dirname(packagePath), 'bin', 'jest.js');
    if (!fs.existsSync(candidate)) {
      throw new Error(`The generator Jest entry point does not exist: ${candidate}`);
    }
    return withVersion({
      command: process.execPath,
      prefixArgs: [candidate],
      shell: false,
    });
  }

  function findNearestPackageRoot(startDirectory) {
    let current = path.resolve(startDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, 'package.json'))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  function resolveJestWorkingDirectory(sourceFile, jestConfig) {
    if (jestConfig) return path.dirname(path.resolve(jestConfig));
    return findNearestPackageRoot(path.dirname(sourceFile)) ?? process.cwd();
  }

  function run(command, args, options) {
    return spawnSync(command, args, options);
  }

  return { findJestRunner, findNearestPackageRoot, resolveJestWorkingDirectory, run };
}
