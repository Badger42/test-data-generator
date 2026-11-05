/**
 * Runtime validation for the public generation report envelope.
 * This intentionally validates stable structural guarantees only; feature
 * payloads remain extensible and are validated by their own contracts.
 */
export function validateGenerationReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['Report must be an object.'] };
  }
  if (!report.generator || typeof report.generator !== 'object') errors.push('generator must be an object.');
  else {
    if (typeof report.generator.name !== 'string' || !report.generator.name) errors.push('generator.name must be a non-empty string.');
    if (typeof report.generator.version !== 'string' || !report.generator.version) errors.push('generator.version must be a non-empty string.');
  }
  if (typeof report.source !== 'string' || !report.source) errors.push('source must be a non-empty string.');
  if (!['javascript', 'typescript'].includes(report.sourceLanguage)) errors.push('sourceLanguage must be javascript or typescript.');
  if (typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) errors.push('generatedAt must be an ISO-compatible date string.');
  if (!Array.isArray(report.limitations) || report.limitations.some(item => typeof item !== 'string')) errors.push('limitations must be an array of strings.');
  if (!Array.isArray(report.functions)) errors.push('functions must be an array.');
  else report.functions.forEach((fn, index) => {
    if (!fn || typeof fn !== 'object') { errors.push(`functions[${index}] must be an object.`); return; }
    if (typeof fn.name !== 'string' || !fn.name) errors.push(`functions[${index}].name must be a non-empty string.`);
    if (!Array.isArray(fn.scenarios)) errors.push(`functions[${index}].scenarios must be an array.`);
    if (!fn.summary || typeof fn.summary !== 'object') errors.push(`functions[${index}].summary must be an object.`);
  });
  return { valid: errors.length === 0, errors };
}

export function assertGenerationReport(report) {
  const result = validateGenerationReport(report);
  if (!result.valid) throw new TypeError(`Invalid generation report: ${result.errors.join(' ')}`);
  return report;
}
