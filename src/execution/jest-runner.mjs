/** Jest executable discovery and process execution adapter. */
export function createJestRunner({ fs, path, process, spawnSync }) {
function getJestPackageVersion(executablePath) {
  if (!executablePath || !path.isAbsolute(executablePath)) return null;
  let current = path.dirname(executablePath);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (manifest.name === 'jest') return manifest.version ?? null;
      } catch { /* keep searching parent package directories */ }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function withVersion(runner, executablePath) {
  return { ...runner, version: getJestPackageVersion(executablePath) };
}

function findJestRunner(explicitPath, sourceFile, jestConfig) {
  if (explicitPath) {
    const candidate = path.resolve(explicitPath);
    if (!fs.existsSync(candidate)) throw new Error(`Jest executable does not exist: ${candidate}`);
    const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(candidate);
    return withVersion({
      command: isNodeScript ? process.execPath : candidate,
      prefixArgs: isNodeScript ? [candidate] : [],
      shell: !isNodeScript && process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate),
    }, isNodeScript ? candidate : null);
  }

  // Prefer the consuming project's Jest over the generator's own devDependency.
  // A config path is the strongest project hint; the source file is next.
  const searchRoots = [...new Set([
    ...(jestConfig ? [path.dirname(path.resolve(jestConfig))] : []),
    path.dirname(sourceFile),
    process.cwd(),
  ])];
  for (const root of searchRoots) {
    let current = path.resolve(root);
    while (true) {
      const candidate = path.join(current, 'node_modules', 'jest', 'bin', 'jest.js');
      if (fs.existsSync(candidate)) return withVersion({ command: process.execPath, prefixArgs: [candidate], shell: false }, candidate);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  // Also support a globally installed Jest executable available on PATH.
  // Resolve its version before returning so old global Jest installations do
  // not bypass the consumer-version compatibility gate.
  const globalRunner = { command: 'jest', prefixArgs: [], shell: process.platform === 'win32' };
  const versionResult = spawnSync(globalRunner.command, ['--version'], {
    encoding: 'utf8', windowsHide: true, shell: globalRunner.shell,
  });
  const versionText = `${versionResult?.stdout ?? ''} ${versionResult?.stderr ?? ''}`;
  const version = versionText.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
  return { ...globalRunner, version };
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
