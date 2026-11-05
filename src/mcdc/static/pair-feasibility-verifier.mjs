/** Verifies unique-cause vectors and preservation of incoming path assignments. */
export function createMcdcPairFeasibilityVerifier({ readPath, isStrictPathPrefix, sameValue, undefinedValue }) {
  function preservesIncomingAssignments(seed, candidate, incomingAssignments, atoms, solutionDomains = []) {
    const paths = atoms.flatMap(item => [item.path, ...(item.valuePath ? [item.valuePath] : [])]);
    return incomingAssignments.every(assignment => {
      const before = readPath(seed, assignment.path);
      const after = readPath(candidate, assignment.path);
      const refinesParentShape = paths.some(path => isStrictPathPrefix(assignment.path, path)) &&
        before.exists && after.exists && before.value !== null && typeof before.value === 'object' &&
        after.value !== null && typeof after.value === 'object' &&
        Array.isArray(before.value) === Array.isArray(after.value);
      const refinesLengthDomain = Boolean(assignment.lengthConstraint && solutionDomains.some(domain =>
        domain.kind === 'integer-length' && JSON.stringify(domain.path) === JSON.stringify(assignment.path)));
      return refinesParentShape || refinesLengthDomain ||
        (before.exists === after.exists && (before.value === undefinedValue && after.value === undefinedValue || sameValue(before.value, after.value)));
    });
  }

  return { preservesIncomingAssignments };
}
