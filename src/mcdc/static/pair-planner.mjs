/**
 * Enumerates logical unique-cause MC/DC candidates in deterministic order.
 * Feasibility of concrete input assignments is deliberately delegated to the solver port.
 */
export function planUniqueCauseCandidates({ atomCount, targetIndex, maxCombinations, evaluateDecision }) {
  if (!Number.isInteger(atomCount) || atomCount < 1) throw new TypeError('atomCount must be a positive integer');
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= atomCount) throw new RangeError('targetIndex is out of range');
  const otherIndexes = Array.from({ length: atomCount }, (_, index) => index).filter(index => index !== targetIndex);
  const total = 2 ** otherIndexes.length;
  const combinationCount = Math.min(total, Math.max(0, Number(maxCombinations) || 0));
  const candidates = [];

  for (let mask = 0; mask < combinationCount; mask += 1) {
    const baseValues = Array(atomCount).fill(false);
    for (let bit = 0; bit < otherIndexes.length; bit += 1) {
      baseValues[otherIndexes[bit]] = Boolean(mask & (1 << bit));
    }
    const falseValues = [...baseValues];
    const trueValues = [...baseValues];
    falseValues[targetIndex] = false;
    trueValues[targetIndex] = true;
    const falseDecision = evaluateDecision(falseValues);
    const trueDecision = evaluateDecision(trueValues);
    if (falseDecision === null || trueDecision === null || falseDecision === trueDecision) continue;
    candidates.push({
      targetIndex,
      baseValues,
      falseValues,
      trueValues,
      falseDecision,
      trueDecision,
      fixedConditions: Object.fromEntries(otherIndexes.map(index => [`C${index + 1}`, baseValues[index]])),
    });
  }

  return { candidates, combinationCount, totalCombinations: total, truncated: combinationCount < total };
}

export function verifyUniqueCauseCandidate(candidate) {
  if (!candidate || !Array.isArray(candidate.falseValues) || !Array.isArray(candidate.trueValues)) return false;
  if (candidate.falseValues.length !== candidate.trueValues.length) return false;
  const target = candidate.targetIndex;
  if (candidate.falseValues[target] !== false || candidate.trueValues[target] !== true) return false;
  for (let index = 0; index < candidate.falseValues.length; index += 1) {
    if (index !== target && candidate.falseValues[index] !== candidate.trueValues[index]) return false;
  }
  return candidate.falseDecision !== candidate.trueDecision;
}
