import { createDataFlowEvidenceBuilder } from './data-flow-evidence.mjs';

function assignmentKeys(assignments) {
  if (assignments instanceof Map) return [...assignments.entries()].map(([key, item]) => item?.path?.join('.') ?? (typeof key === 'string' ? key : '')).filter(Boolean);
  if (Array.isArray(assignments)) return assignments.map(item => item.path?.join('.') ?? '').filter(Boolean);
  return [];
}

/** Combines solver path evidence with conservative static Data Flow provenance. */
export function createScenarioEvidenceBuilder(options = {}) {
  const dataFlowEvidenceBuilder = options.dataFlowEvidenceBuilder ?? createDataFlowEvidenceBuilder();
  function build(input = {}) {
    const assumptions = [...new Set([
      ...(input.incoming ?? []).flatMap(solution => assignmentKeys(solution.assignments)),
      ...assignmentKeys(input.assignments),
      ...(input.additionalAssumptions ?? []),
    ])];
    const unsupported = [...new Set([
      ...(input.unsupported ?? []),
      ...(input.incoming ?? []).flatMap(solution => solution.unsupported ?? []),
    ])];
    const warnings = unsupported.map(message => ({
      code: 'constraint-unsupported', message: String(message), severity: 'warning',
      ...(input.sourceSpan ? { sourceSpan: input.sourceSpan } : {}),
    }));
    const dataFlowEvidence = dataFlowEvidenceBuilder.build({
      dataFlowModel: input.dataFlowModel,
      assignments: input.assignments,
      sourceSpan: input.sourceSpan,
      target: input.target,
    });
    return { assumptions, unsupported, warnings, evidence: dataFlowEvidence };
  }
  return Object.freeze({ build });
}
