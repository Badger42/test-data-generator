export const ANALYSIS_RUN_FORM_SCHEMA_VERSION = '1.0.0';

const STATUSES = new Set(['passed', 'failed', 'skipped', 'pending', 'not-run']);

export function validateAnalysisRunForm(form) {
  const errors = [];
  if (!form || typeof form !== 'object' || Array.isArray(form)) return { valid: false, errors: ['Execution form must be an object.'] };
  if (form.formType !== 'branch-scenarios-execution-results-form') errors.push('formType is invalid.');
  if (form.schemaVersion !== ANALYSIS_RUN_FORM_SCHEMA_VERSION) errors.push(`schemaVersion must be ${ANALYSIS_RUN_FORM_SCHEMA_VERSION}.`);
  if (typeof form.reportId !== 'string' || !form.reportId) errors.push('reportId is required.');
  if (!form.project || !/^[a-f0-9]{64}$/.test(form.project.projectFingerprint ?? '')) errors.push('project.projectFingerprint must be a SHA-256 digest.');
  if (form.project && !/^[a-f0-9]{64}$/.test(form.project.sourceSha256 ?? '')) errors.push('project.sourceSha256 must be a SHA-256 digest.');
  if (!form.execution || typeof form.execution !== 'object') errors.push('execution is required.');
  if (!form.testResults || !Array.isArray(form.testResults.cases)) errors.push('testResults.cases must be an array.');
  if (form.testResults && (!Number.isInteger(form.testResults.plannedCases) || form.testResults.plannedCases < 0 || !Number.isInteger(form.testResults.truncatedCases ?? 0) || (form.testResults.truncatedCases ?? 0) < 0)) errors.push('testResults plannedCases/truncatedCases must be non-negative integers.' );
  for (const [index, item] of (form.testResults?.cases ?? []).entries()) {
    if (typeof item.scenarioId !== 'string' || !item.scenarioId) errors.push(`testResults.cases[${index}].scenarioId is required.`);
    if (!STATUSES.has(item.status)) errors.push(`testResults.cases[${index}].status is invalid.`);
  }
  for (const [index, item] of (form.testResults?.additionalTestsNotLinkedToScenarios ?? []).entries()) {
    if (!item || typeof item !== 'object') errors.push(`testResults.additionalTestsNotLinkedToScenarios[${index}] must be an object.`);
    else if (item.status != null && !STATUSES.has(item.status)) errors.push(`testResults.additionalTestsNotLinkedToScenarios[${index}].status is invalid.`);
  }
  if (!form.coverage?.metrics || typeof form.coverage.metrics !== 'object') errors.push('coverage.metrics is required.');
  if (!form.completion || typeof form.completion.ready !== 'boolean' || typeof form.completion.completed !== 'boolean') errors.push('completion.ready/completed flags are required.');
  if (!Array.isArray(form.notes) || !Array.isArray(form.issues) || !Array.isArray(form.artifacts?.custom)) errors.push('notes, issues and artifacts.custom must be arrays.');
  return { valid: errors.length === 0, errors };
}

export function assertAnalysisRunForm(form) {
  const validation = validateAnalysisRunForm(form);
  if (!validation.valid) throw new TypeError(`Invalid analysis run form: ${validation.errors.join(' ')}`);
  return form;
}
