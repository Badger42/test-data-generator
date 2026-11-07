/** Loads the optional project-level CLI run configuration. */
export function loadRunConfig({ fs, path, cwd, explicitPath = null, disabled = false }) {
  if (!fs || !path || !cwd) throw new TypeError('loadRunConfig requires fs, path and cwd.');
  if (disabled && explicitPath) throw new Error('--run-config cannot be combined with --no-run-config.');
  if (disabled) return {};
  const configPath = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.resolve(cwd, 'branch-scenarios.config.json');
  if (!fs.existsSync(configPath)) {
    if (explicitPath) throw new Error(`Run configuration file does not exist: ${configPath}`);
    return {};
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read run configuration ${configPath}: ${error.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Run configuration ${configPath} must contain a JSON object.`);
  }
  return config;
}
