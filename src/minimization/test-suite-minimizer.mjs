/** Deterministic set-cover minimizer over an executed candidate suite. */
import { buildCoverageObligationModel } from './obligation-builder.mjs';

export function buildMinimalTestSet(scenarioAttribution, staticTargets, pairExecution, options = {}) {
  const maxExactCandidates = options.maxExactCandidates ?? 24;
  const maxExactObligations = options.maxExactObligations ?? 128;
  const maxSearchNodes = options.maxSearchNodes ?? 150000;
  if (![maxExactCandidates, maxExactObligations, maxSearchNodes].every(value => Number.isInteger(value) && value > 0)) {
    throw new TypeError('Minimizer limits must be positive integers.');
  }
  const model = buildCoverageObligationModel(scenarioAttribution, staticTargets, pairExecution);
  if (model.status === 'unavailable') return model;
  const { cases, obligationList, allObligationIds, caseCoverage, fallbackObligationIds } = model;
  const selected = new Set();
  const covered = new Set();

  const eligible = cases;
  const required = [...allObligationIds].filter(id => !covered.has(id));
  const selectedBySearch = new Set();
  let algorithm = 'branch-and-bound-exact-set-cover';
  let exactMinimumProven = false;
  let searchNodes = 0;
  let searchLimitReached = false;

  const candidates = eligible.map(item => ({ id: item.caseId, covers: caseCoverage.get(item.caseId) ?? new Set() }))
    .filter(item => [...item.covers].some(id => required.includes(id)));
  const requiredSet = new Set(required);
  const candidateCount = candidates.length;
  const MAX_SEARCH_NODES = maxSearchNodes;

  if (candidateCount <= maxExactCandidates && required.length <= maxExactObligations) {
    const byObligation = new Map(required.map(id => [id, candidates.filter(candidate => candidate.covers.has(id))]));
    let best = null;
    const recurse = (remaining, chosen) => {
      searchNodes += 1;
      if (searchNodes > MAX_SEARCH_NODES) { searchLimitReached = true; return; }
      if (!remaining.size) {
        if (!best || chosen.length < best.length) best = [...chosen];
        return;
      }
      if (best && chosen.length >= best.length) return;
      let selectedObligation = null;
      let options = null;
      for (const id of remaining) {
        const available = (byObligation.get(id) ?? []).filter(candidate => !chosen.includes(candidate.id));
        if (!options || available.length < options.length) { selectedObligation = id; options = available; }
        if (available.length <= 1) break;
      }
      if (!options?.length) return;
      for (const candidate of options) {
        const nextRemaining = new Set([...remaining].filter(id => !candidate.covers.has(id)));
        recurse(nextRemaining, [...chosen, candidate.id]);
        if (searchLimitReached) return;
      }
    };
    recurse(requiredSet, []);
    if (best && !searchLimitReached) {
      for (const id of best) selectedBySearch.add(id);
      exactMinimumProven = true;
    } else {
      algorithm = 'greedy-set-cover-search-limit';
    }
  } else {
    algorithm = 'greedy-set-cover';
  }

  if (!exactMinimumProven) {
    selectedBySearch.clear();
    const uncovered = new Set(requiredSet);
    const remaining = [...candidates];
    while (uncovered.size && remaining.length) {
      remaining.sort((a, b) => {
        const gainA = [...a.covers].filter(id => uncovered.has(id)).length;
        const gainB = [...b.covers].filter(id => uncovered.has(id)).length;
        return gainB - gainA || a.id.localeCompare(b.id);
      });
      const best = remaining.shift();
      const gain = [...best.covers].filter(id => uncovered.has(id));
      if (!gain.length) break;
      selectedBySearch.add(best.id);
      for (const id of gain) uncovered.delete(id);
    }
  }

  for (const id of selectedBySearch) selected.add(id);
  const finalCovered = new Set();
  for (const id of selected) for (const obligation of caseCoverage.get(id) ?? []) finalCovered.add(obligation);
  const missing = [...allObligationIds].filter(id => !finalCovered.has(id));
  const selectedCases = cases.filter(item => selected.has(item.caseId));
  const mcdcPairs = new Map();
  for (const pair of pairExecution ?? []) {
    if (!['runtime-mcdc-verified', 'runtime-mcdc-verified-with-short-circuit-inference'].includes(pair.status)) continue;
    mcdcPairs.set(pair.pairId, pair);
  }
  const mcdcPairsPreserved = [...mcdcPairs.values()].filter(pair =>
    finalCovered.has(`mcdc:${pair.pairId}:conditionFalse`) && finalCovered.has(`mcdc:${pair.pairId}:conditionTrue`)).length;

  return {
    status: missing.length ? 'partial' : fallbackObligationIds.size ? 'complete-with-conservative-fallbacks' : 'complete',
    objective: 'Preserve every runtime-observed static branch outcome, both sides of each runtime-verified MC/DC pair, and at least one generated candidate for each conservative static-target outcome.',
    algorithm: exactMinimumProven ? algorithm : (searchLimitReached ? algorithm : 'greedy-set-cover'),
    exactMinimumProven,
    searchNodes,
    candidateCases: cases.length,
    selectedCases: selectedCases.length,
    removedCases: cases.length - selectedCases.length,
    reductionPct: cases.length ? Number(((cases.length - selectedCases.length) / cases.length * 100).toFixed(2)) : 0,
    obligations: obligationList.length,
    coveredObligations: obligationList.length - missing.length,
    missingObligations: missing,
    uncoveredBranchOutcomes: missing.filter(id => id.startsWith('branch:') || id.startsWith('fallback:')),
    conservativeFallbackCaseIds: selectedCases.filter(item => [...(caseCoverage.get(item.caseId) ?? [])].some(id => fallbackObligationIds.has(id))).map(item => item.caseId),
    conservativeFallbacks: obligationList.filter(item => item.type === 'conservative-static-target').map(({ id, caseIds, ...item }) => ({ ...item, obligationId: id, candidateCaseIds: caseIds, selectedCaseIds: caseIds.filter(caseId => selected.has(caseId)) })),
    branchObligations: obligationList.filter(item => item.type === 'branch-outcome' || item.type === 'conservative-static-target').length,
    mcdcPairsEligible: mcdcPairs.size,
    mcdcPairsPreserved,
    selectedCaseIds: selectedCases.map(item => item.caseId),
    removedCaseIds: cases.filter(item => !selected.has(item.caseId)).map(item => item.caseId),
    scenarios: selectedCases.map(item => ({
      caseId: item.caseId,
      testName: item.testName,
      arguments: item.arguments,
      mocks: item.mocks,
      references: item.references,
      coveredBranchOutcomes: item.coveredBranchOutcomes,
      mcdcPairSides: item.mcdcPairSides,
    })),
    notes: [
      'This is a minimal set-cover solution over the obligations observed in the executed generated suite, not a proof of a globally minimal test suite over all possible inputs.',
      'Exact minimum is proven only when exactMinimumProven=true; otherwise the deterministic greedy approximation is used.',
      'Conservative target-reference fallback obligations are not runtime proof. Their candidate cases participate in set cover and at least one selected candidate is retained per such outcome.',
    ],
  };
}

export function createTestSuiteMinimizer(options = {}) {
  return {
    buildMinimalTestSet: (attribution, targets, pairs) => buildMinimalTestSet(attribution, targets, pairs, options),
    minimize: (attribution, targets, pairs) => buildMinimalTestSet(attribution, targets, pairs, options),
  };
}
