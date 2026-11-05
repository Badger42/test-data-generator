export function validateAnalysisReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { valid: false, errors: ['Analysis report must be an object.'] };
  if (report.reportType !== 'branch-scenarios-analysis-report') errors.push('reportType must be branch-scenarios-analysis-report.');
  if (typeof report.schemaVersion !== 'string' || !report.schemaVersion) errors.push('schemaVersion must be a non-empty string.');
  if (typeof report.reportId !== 'string' || !report.reportId) errors.push('reportId must be a non-empty string.');
  if (!report.generator || typeof report.generator.version !== 'string') errors.push('generator.version is required.');
  if (!report.environment || typeof report.environment.node !== 'string') errors.push('environment.node is required.');
  if (!report.project || typeof report.project.root !== 'string') errors.push('project.root is required.');
  if (report.project && !/^[a-f0-9]{64}$/.test(report.project.fingerprint ?? '')) errors.push('project.fingerprint must be a SHA-256 digest of the analyzed project files.');
  if (!report.run || !['shape', 'hash', 'include'].includes(report.run.valueMode)) errors.push('run.valueMode must be shape, hash or include.');
  if (!report.summary || typeof report.summary.scenarios !== 'number') errors.push('summary.scenarios is required.');
  if (!Array.isArray(report.functions)) errors.push('functions must be an array.');
  if (!report.execution || typeof report.execution.status !== 'string') errors.push('execution.status is required.');
  if (!report.externalExecution || typeof report.externalExecution.status !== 'string') errors.push('externalExecution.status is required.');
  if (!report.privacy || typeof report.privacy.absolutePathsIncluded !== 'boolean') errors.push('privacy.absolutePathsIncluded is required.');
  return { valid: errors.length === 0, errors };
}

export function assertAnalysisReport(report) {
  const validation = validateAnalysisReport(report);
  if (!validation.valid) throw new TypeError(`Invalid analysis report: ${validation.errors.join(' ')}`);
  return report;
}
