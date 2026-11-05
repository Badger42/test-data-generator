/**
 * Converts passing per-scenario runtime attribution into explicit set-cover
 * obligations. Internal Sets/Maps are intentional: this is an in-process IR,
 * not a serialized report DTO.
 */
export function buildCoverageObligationModel(scenarioAttribution, staticTargets, pairExecution) {
  if (!scenarioAttribution?.cases) return {
    status: 'unavailable', reason: 'Per-scenario runtime attribution is not available. Run Jest with --coverage-feedback and runtime instrumentation.',
  };

  const cases = scenarioAttribution.cases.filter(item => item.status === 'passed');
  const caseById = new Map(cases.map(item => [item.caseId, item]));
  const scenarioToCaseIds = new Map();
  for (const item of cases) {
    for (const reference of item.references ?? []) {
      if (!reference.scenarioId) continue;
      const ids = scenarioToCaseIds.get(reference.scenarioId) ?? new Set();
      ids.add(item.caseId);
      scenarioToCaseIds.set(reference.scenarioId, ids);
    }
  }
  const obligations = new Map();

  const addObligation = (id, type, details = {}) => {
    if (!obligations.has(id)) obligations.set(id, { id, type, ...details, caseIds: new Set() });
    return obligations.get(id);
  };

  // Runtime-observed branch obligations: each actual decision outcome is a separate obligation.
  for (const item of cases) {
    for (const outcome of item.coveredBranchOutcomes) {
      const obligation = addObligation(`branch:${outcome.branchId}:${JSON.stringify(outcome.outcome)}`, 'branch-outcome', {
        branchId: outcome.branchId,
        outcome: outcome.outcome,
        evidence: 'runtime-decision-trace',
      });
      obligation.caseIds.add(item.caseId);
    }
  }

  // Preserve non-runtime-mapped targets conservatively instead of silently dropping them.
  for (const target of staticTargets ?? []) {
    if (target.coverageApplicable === false) continue;
    const isSwitch = target.kind === 'switch';
    const mappedOutcomes = new Set();
    for (const item of cases) {
      for (const observed of item.coveredBranchOutcomes) {
        if (observed.branchId === target.id) mappedOutcomes.add(JSON.stringify(observed.outcome));
      }
    }
    for (const outcome of target.outcomes ?? []) {
      const key = JSON.stringify(outcome.value);
      if (mappedOutcomes.has(key)) continue;
      const candidateIds = [...new Set((outcome.scenarioIds ?? []).flatMap(id => [...(scenarioToCaseIds.get(id) ?? [])]))];
      if (!candidateIds.length) continue;
      const obligation = addObligation(`fallback:${target.id}:${key}`, 'conservative-static-target', {
        branchId: target.id,
        outcome: outcome.value,
        evidence: isSwitch ? 'switch-target-reference' : 'aggregate-or-unmapped-target-reference',
        mappingStatus: target.mappingStatus ?? target.coverageStatus ?? 'unknown',
      });
      for (const id of candidateIds) {
        obligation.caseIds.add(id);
      }
    }
  }

  // Both sides of every runtime-verified MC/DC pair are independent obligations.
  for (const pair of pairExecution ?? []) {
    if (!['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)) continue;
    for (const side of ['conditionFalse', 'conditionTrue']) {
      const caseId = side === 'conditionFalse' ? pair.conditionFalseCaseId : pair.conditionTrueCaseId;
      if (!caseById.has(caseId)) continue;
      const obligation = addObligation(`mcdc:${pair.pairId}:${side}`, 'mcdc-pair-side', {
        pairId: pair.pairId,
        decisionId: pair.decisionId,
        conditionId: pair.conditionId,
        side,
        evidence: 'runtime-mcdc-verification',
      });
      obligation.caseIds.add(caseId);
    }
  }

  const obligationList = [...obligations.values()].map(item => ({ ...item, caseIds: [...item.caseIds] }));
  const allObligationIds = new Set(obligationList.map(item => item.id));
  const caseCoverage = new Map(cases.map(item => [item.caseId, new Set([
    ...item.coveredBranchOutcomes.map(outcome => `branch:${outcome.branchId}:${JSON.stringify(outcome.outcome)}`),
    ...item.mcdcPairSides.filter(side => side.verified).map(side => `mcdc:${side.pairId}:${side.side}`),
  ])]));
  for (const obligation of obligationList) {
    if (obligation.type === 'conservative-static-target') {
      for (const id of obligation.caseIds) caseCoverage.get(id)?.add(obligation.id);
    }
  }

  const fallbackObligationIds = new Set(obligationList.filter(item => item.type === 'conservative-static-target').map(item => item.id));
  return {
    cases,
    obligationList,
    allObligationIds,
    caseCoverage,
    fallbackObligationIds,
  };
}
