/** Map static branch targets to Istanbul branch entries conservatively. */
export function createBranchMapper({ fs, path, platform = process.platform, canonicalCoveragePath }) {
function normalizeCoverageFileMap(coverageMap, sourceFile) {
  const absoluteSource = path.resolve(sourceFile);
  const canonicalSource = canonicalCoveragePath(absoluteSource);
  for (const [fileName, fileCoverage] of Object.entries(coverageMap ?? {})) {
    const absoluteCandidate = path.resolve(fileName);
    if (absoluteCandidate === absoluteSource || canonicalCoveragePath(absoluteCandidate) === canonicalSource) {
      return { fileName, fileCoverage, matchedBy: absoluteCandidate === absoluteSource ? 'absolute-path' : 'realpath' };
    }
  }
  return null;
}

function collectStaticBranchTargets(functionResults) {
  const targets = new Map();
  for (const fn of functionResults) {
    for (const scenario of fn.scenarios ?? []) {
      const target = scenario.target;
      if (!target?.branchId) continue;
      if (!targets.has(target.branchId)) {
        targets.set(target.branchId, {
          id: target.branchId,
          functionName: fn.name,
          kind: target.kind,
          loopType: target.loopType ?? null,
          callbackMethod: target.callbackMethod ?? null,
          line: target.line,
          column: target.column,
          endLine: target.endLine ?? null,
          endColumn: target.endColumn ?? null,
          startOffset: target.startOffset ?? null,
          endOffset: target.endOffset ?? null,
          coverageLine: target.coverageLine ?? null,
          coverageColumn: target.coverageColumn ?? null,
          coverageStartOffset: target.coverageStartOffset ?? null,
          coverageEndOffset: target.coverageEndOffset ?? null,
          coverageAnchor: target.coverageAnchor ?? null,
          runtimeDecisionId: target.runtimeDecisionId ?? null,
          coverageApplicable: target.kind !== 'array-predicate' && !String(target.loopType ?? '').startsWith('array-') && !(target.kind === 'loop' && target.condition === 'true (no condition)'),
          condition: target.condition,
          outcomes: [],
        });
      }
      const entry = targets.get(target.branchId);
      const key = JSON.stringify(target.outcome);
      if (!entry.outcomes.some(outcome => JSON.stringify(outcome.value) === key)) {
        entry.outcomes.push({
          value: target.outcome,
          coverageOutcomeIndex: Number.isInteger(target.coverageOutcomeIndex) ? target.coverageOutcomeIndex : null,
          scenarioIds: [],
        });
      }
      entry.outcomes.find(outcome => JSON.stringify(outcome.value) === key).scenarioIds.push(scenario.id);
    }
  }
  return [...targets.values()];
}

function coverageTypeMatches(targetKind, coverageKind) {
  const mapping = {
    if: ['if'],
    ternary: ['cond-expr'],
    switch: ['switch'],
    loop: ['if', 'while', 'for', 'binary-expr'],
  };
  const accepted = mapping[targetKind];
  return !accepted || accepted.includes(coverageKind);
}

function coverageLocationScore(target, entry) {
  // Jest's V8 provider converts source ranges to one-counter Istanbul entries
  // with type 'branch'. For an if target, this is the boolean-condition range,
  // not a semantic two-outcome Istanbul if branch.
  const isV8IfConditionRange = target.kind === 'if' && entry.type === 'branch';
  const hasCoverageAnchor = !isV8IfConditionRange && Number.isInteger(target.coverageLine) && Number.isInteger(target.coverageColumn);
  const expectedLine = isV8IfConditionRange ? target.line : hasCoverageAnchor ? target.coverageLine : target.line;
  const expectedColumn = isV8IfConditionRange ? target.column : hasCoverageAnchor ? target.coverageColumn : target.column;
  if (!expectedLine || entry.loc?.start?.line !== expectedLine) return null;
  if (!isV8IfConditionRange && !coverageTypeMatches(target.kind, entry.type)) return null;

  const actualColumn = Number(entry.loc?.start?.column);
  const columnDistance = Number.isFinite(actualColumn) && Number.isFinite(expectedColumn)
    ? Math.abs((actualColumn + 1) - expectedColumn)
    : Number.MAX_SAFE_INTEGER;
  const expectedEndLine = isV8IfConditionRange ? target.endLine : hasCoverageAnchor ? null : target.endLine;
  const expectedEndColumn = isV8IfConditionRange ? target.endColumn : hasCoverageAnchor ? null : target.endColumn;
  const actualEndLine = entry.loc?.end?.line;
  const actualEndColumn = entry.loc?.end?.column;
  const endLineDistance = expectedEndLine && actualEndLine ? Math.abs(expectedEndLine - actualEndLine) : 0;
  const endColumnDistance = expectedEndColumn && actualEndColumn && endLineDistance === 0
    ? Math.abs(expectedEndColumn - (actualEndColumn + 1)) : 0;
  // Matching both condition boundaries distinguishes the complete expression
  // from nested atomic-condition ranges emitted by the V8 provider.
  return { columnDistance, endLineDistance, endColumnDistance, isV8IfConditionRange,
    score: columnDistance * 1000 + endLineDistance * 10 + Math.min(endColumnDistance, 9) };
}
function mapCoverageBranches(fileCoverage, functionResults) {
  const coverageEntries = Object.entries(fileCoverage.branchMap ?? {}).map(([id, branch]) => ({
    id,
    type: branch.type ?? 'unknown',
    loc: branch.loc ?? null,
    locations: branch.locations ?? [],
    counts: fileCoverage.b?.[id] ?? [],
  }));
  const staticTargets = collectStaticBranchTargets(functionResults);
  const candidatesByTarget = new Map();
  const preferredOwners = new Map();

  for (const target of staticTargets) {
    if (target.coverageApplicable === false) {
      candidatesByTarget.set(target.id, []);
      continue;
    }
    const candidates = coverageEntries
      .map(entry => {
        const score = coverageLocationScore(target, entry);
        return score ? { ...entry, ...score } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.score - right.score);
    candidatesByTarget.set(target.id, candidates);
    const best = candidates[0];
    if (best && target.kind !== 'switch') {
      const owners = preferredOwners.get(best.id) ?? [];
      owners.push(target.id);
      preferredOwners.set(best.id, owners);
    }
  }

  const targets = staticTargets.map(target => {
    const candidates = candidatesByTarget.get(target.id) ?? [];
    if (target.coverageApplicable === false) {
      return { ...target, coverageStatus: 'not-applicable', mappingStatus: 'not-applicable', coverageBranchId: null, coverageOutcomes: [] };
    }
    if (!candidates.length) {
      return { ...target, coverageStatus: 'not-mapped', mappingStatus: 'no-candidate', coverageBranchId: null, coverageOutcomes: [] };
    }

    const best = candidates[0];
    const equallyGood = candidates.filter(candidate => candidate.score === best.score);
    const sharedByTargets = target.kind === 'switch' ? [] : (preferredOwners.get(best.id) ?? []).filter(id => id !== target.id);
    const isAmbiguous = equallyGood.length > 1 || sharedByTargets.length > 0;
    const maxColumnDistance = 8;
    if (isAmbiguous) {
      return {
        ...target,
        coverageStatus: 'ambiguous',
        mappingStatus: 'ambiguous',
        coverageBranchId: null,
        candidateCoverageBranchIds: equallyGood.map(candidate => candidate.id),
        conflictingStaticTargetIds: sharedByTargets,
        coverageOutcomes: [],
      };
    }
    if (best.columnDistance > maxColumnDistance) {
      return {
        ...target,
        coverageStatus: 'not-mapped',
        mappingStatus: 'outside-location-tolerance',
        coverageBranchId: null,
        candidateCoverageBranchId: best.id,
        columnMatchDistance: best.columnDistance,
        coverageOutcomes: [],
      };
    }

    const coverageOutcomes = best.counts.map((count, index) => ({
      index,
      count,
      covered: Number(count) > 0,
      location: best.locations[index] ?? null,
    }));
    const isV8IfConditionRange = best.isV8IfConditionRange === true;
    const outcomeDetails = target.outcomes.map(outcome => {
      // One V8 range counter cannot establish separate true/false outcomes.
      let coverageOutcomeIndex = isV8IfConditionRange ? null : outcome.coverageOutcomeIndex;
      if (!Number.isInteger(coverageOutcomeIndex) && typeof outcome.value === 'boolean' && ['if', 'cond-expr', 'while', 'for'].includes(best.type)) {
        coverageOutcomeIndex = outcome.value ? 0 : 1;
      }
      const matchedOutcome = Number.isInteger(coverageOutcomeIndex) ? coverageOutcomes[coverageOutcomeIndex] : null;
      return {
        ...outcome,
        coverageOutcomeIndex: Number.isInteger(coverageOutcomeIndex) ? coverageOutcomeIndex : null,
        covered: matchedOutcome ? matchedOutcome.covered : null,
        coverageCount: matchedOutcome?.count ?? null,
      };
    });

    const relevantOutcomes = outcomeDetails.filter(item => item.covered !== null);
    const relevantCovered = relevantOutcomes.filter(item => item.covered).length;
    const coveredCount = target.kind === 'switch' && relevantOutcomes.length
      ? relevantCovered
      : coverageOutcomes.filter(outcome => outcome.covered).length;
    const relevantTotal = target.kind === 'switch' && relevantOutcomes.length
      ? relevantOutcomes.length
      : coverageOutcomes.length;
    const coverageStatus = isV8IfConditionRange
      ? (coverageOutcomes.some(outcome => outcome.covered) ? 'partially-covered' : 'uncovered')
      : relevantTotal === 0 ? 'not-mapped'
        : coveredCount === 0 ? 'uncovered'
        : coveredCount === relevantTotal ? 'covered'
        : 'partially-covered';

    return {
      ...target,
      outcomes: outcomeDetails,
      coverageStatus,
      mappingStatus: isV8IfConditionRange ? 'v8-condition-range-only' : best.columnDistance === 0 ? 'exact-start' : 'nearest-start',
      ...(isV8IfConditionRange ? { coverageOutcomeMapping: 'not-available-from-v8-range-map' } : {}),
      coverageBranchId: best.id,
      coverageType: best.type,
      columnMatchDistance: best.columnDistance,
      endLineMatchDistance: best.endLineDistance,
      endColumnMatchDistance: best.endColumnDistance,
      coverageOutcomes,
    };
  });
  return { coverageEntries, targets };
}

  return { normalizeCoverageFileMap, collectStaticBranchTargets, coverageTypeMatches, coverageLocationScore, mapCoverageBranches };
}
