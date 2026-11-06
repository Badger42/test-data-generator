/** Jest executable discovery and process execution adapter. */
export function createJestRunner({ fs, path, process, spawnSync }) {
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

  function findJestRunner(explicitPath, sourceFile, jestConfig) {
    if (explicitPath) {
      const candidate = path.resolve(explicitPath);
      if (!fs.existsSync(candidate)) throw new Error(`Jest executable does not exist: ${candidate}`);
      const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(candidate);
      const shimTarget = process.platform === 'win32' ? resolveWindowsShimTarget(candidate) : null;
      const nodeScript = isNodeScript ? candidate : shimTarget;
      return withVersion({
        command: nodeScript ? process.execPath : candidate,
        prefixArgs: nodeScript ? [nodeScript] : [],
        shell: !nodeScript && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate),
      });
    }

    // Prefer the consuming project's Jest over the generator's own devDependency.
    const searchRoots = [...new Set([
      ...(jestConfig ? [path.dirname(path.resolve(jestConfig))] : []),
      path.dirname(sourceFile),
      process.cwd(),
    ])];
    for (const root of searchRoots) {
      let current = path.resolve(root);
      while (true) {
        const candidate = path.join(current, 'node_modules', 'jest', 'bin', 'jest.js');
        if (fs.existsSync(candidate)) {
          return withVersion({ command: process.execPath, prefixArgs: [candidate], shell: false });
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Also support a globally installed Jest executable available on PATH.
    return withVersion({ command: 'jest', prefixArgs: [], shell: process.platform === 'win32' });
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
