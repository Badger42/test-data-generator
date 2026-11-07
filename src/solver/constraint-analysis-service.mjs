/**
 * IR-first constraint analysis service. It owns compilation/solver coordination and
 * delegates unsupported or unproven cases to the recursive AST fallback adapter.
 */
export function createConstraintAnalysisService(dependencies) {
  const {
    ts, compileTypescriptCondition, collectConstraintPaths, createConstraintIR,
    constraintPathHint, buildConstraintSeed, isStrictPathPrefix, deleteConstraintPath,
    readConstraintPath, sameValue, makeAssignment, isDefinitelyAssignable,
    substituteKnownAliases, evaluateStaticCondition, unwrap, unsupportedSolution,
    replaceExternalCallResults = null,
    recursiveAstFallbackAdapter,
  } = dependencies;

function constraintPathRefsForAtoms(atoms, collectConstraintPaths) {
  const refs = [];
  for (const item of atoms ?? []) refs.push(...collectConstraintPaths(item));
  const unique = new Map();
  for (const ref of refs) unique.set(JSON.stringify([ref.path, ref.accessor]), ref);
  return [...unique.values()];
}

function lengthConstraintFromDomain(domain, candidate) {
  if (!domain || domain.kind !== 'integer-length' || (!Array.isArray(candidate) && typeof candidate !== 'string')) return null;
  const min = Math.max(0, domain.lower
    ? (domain.lower.inclusive ? Math.ceil(domain.lower.value) : Math.floor(domain.lower.value) + 1)
    : 0);
  const max = Math.min(8, domain.upper
    ? (domain.upper.inclusive ? Math.floor(domain.upper.value) : Math.ceil(domain.upper.value) - 1)
    : 8);
  const excluded = (domain.excluded ?? []).filter(value => Number.isInteger(value) && value >= 0 && value <= 8);
  if (min > max || !Array.from({ length: max - min + 1 }, (_, index) => min + index).some(value => !excluded.includes(value))) return null;
  return { path: [...domain.path], lengthConstraint: { min, max, excluded, isArray: Array.isArray(candidate), itemValue: Array.isArray(candidate) ? (candidate[0] ?? null) : null } };
}

function trySolveWithConstraintIR(node, desired, operationContext, incomingSolutions) {
  const maxAlternatives = operationContext.limits.maxAlternatives;
  const maxScenarios = operationContext.limits.maxScenarios;
  if (operationContext.constraints.engine !== 'hybrid') return null;
  const incoming = incomingSolutions ?? [{ assignments: new Map(), unsupported: [] }];
  if (!incoming.length) return [];
  operationContext.events.incrementConstraintStat('irAttempts');

  let ir;
  try {
    const pathTypes = {};
    // External call results that are not assigned to a local variable are
    // projected to synthetic mock roots before compiling the condition.
    const compilerNode = replaceExternalCallResults?.(node, operationContext) ?? node;
    const compilerOptions = {
      resolveAlias: operationContext.constraints.expressionAliasResolver,
      isSymbolicRoot: identifier => {
        const name = identifier.text;
        try { if (operationContext.constraints.expressionAliasResolver?.(identifier)) return true; } catch { /* unresolved aliases remain non-symbolic */ }
        const symbol = operationContext.function.checker.getSymbolAtLocation(identifier);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (declaration && ts.isParameter(declaration)) return true;
        if (operationContext.paths.localMockMap.has(name) || operationContext.paths.pathAliases.has(name)) return true;
        // Loop declarations can be materialized through the active loop/path alias mapping.
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent &&
            (ts.isForOfStatement(declaration.parent.parent) || ts.isForInStatement(declaration.parent.parent))) return true;
        return false;
      },
      isNumericExpression: expression => {
        try {
          const type = operationContext.function.checker.getTypeAtLocation(expression);
          return Boolean(type.flags & ts.TypeFlags.NumberLike);
        } catch { return false; }
      },
    };
    const provisional = compileTypescriptCondition(compilerNode, ts, compilerOptions);
    const paths = constraintPathRefsForAtoms(provisional.atoms, collectConstraintPaths);
    for (const ref of paths) {
      const path = ref.path;
      const { type, hint } = constraintPathHint(path, operationContext, node);
      if (type && operationContext.function.checker.isTupleType(type) && ref.accessor === 'length') {
        operationContext.events.recordConstraintFallback(`Tuple length at ${path.join('.')} is fixed by its declared tuple shape and remains on the recursive AST path.`);
        return null;
      }
      pathTypes[JSON.stringify(path)] = hint;
    }
    ir = compileTypescriptCondition(compilerNode, ts, { ...compilerOptions, pathTypes });
  } catch (error) {
    operationContext.events.recordConstraintFallback(`IR compilation: ${error.message}`);
    return null;
  }

  if (ir.atoms.some(item => item.operator === 'unsupported')) {
    operationContext.events.recordConstraintFallback('Expression contains an unsupported IR atom');
    return null;
  }

  const results = [];
  let rejectedIncomingCandidate = false;
  const uniquePaths = new Map();
  const pathTypesByKey = {};
  for (const ref of constraintPathRefsForAtoms(ir.atoms, collectConstraintPaths)) {
    uniquePaths.set(JSON.stringify(ref.path), ref.path);
    pathTypesByKey[JSON.stringify(ref.path)] ??= ref.pathTypeHint ?? 'unknown';
  }
  const pathOrder = new Map([...uniquePaths.keys()].map((key, index) => [key, index]));
  const orderedPaths = [...uniquePaths.values()].sort((a, b) =>
    a.length - b.length || pathOrder.get(JSON.stringify(a)) - pathOrder.get(JSON.stringify(b)));
  for (const incomingSolution of incoming) {
    if (incomingSolution.unsupported?.length) {
      operationContext.events.recordConstraintFallback('Incoming path contains unsupported incoming constraints');
      return null;
    }

    const seed = buildConstraintSeed(incomingSolution, ir.atoms, operationContext, node);
    const incomingAssignments = [...incomingSolution.assignments.values()];
    // A prior parent-object assignment often contains type-derived defaults
    // (e.g. age: 1) used only to make `if (passenger)` executable. When a
    // later branch constrains passenger.age, that nested default must not
    // outrank the actual constraint representative (e.g. age: 17).
    for (const item of ir.atoms) {
      const paths = [item.path, ...(item.valuePath ? [item.valuePath] : [])];
      for (const path of paths) {
        const hasExactIncomingConstraint = incomingAssignments.some(assignment =>
          JSON.stringify(assignment.path) === JSON.stringify(path));
        if (!hasExactIncomingConstraint && incomingAssignments.some(assignment => isStrictPathPrefix(assignment.path, path))) {
          deleteConstraintPath(seed, path);
        }
      }
    }
    const incomingSnapshots = incomingAssignments.map(assignment => ({
      assignment,
      path: assignment.path,
      value: readConstraintPath(seed, assignment.path),
    }));
    const solved = operationContext.constraints.solver.solveAll(ir, {
      desired,
      maxCandidates: Math.min(8192, Math.max(256, maxScenarios * 64)),
      maxSolutions: maxAlternatives,
      maxBranches: operationContext.limits.maxMcdcCombinations ?? 512,
      // Ordinary generation keeps one representative per disjoint path. During
      // iterative coverage feedback, widen representatives per clause so the
      // runner can discover runtime-specific values (for example another enum
      // member) after the first concrete witness did not cover the mapped branch.
      solutionsPerClause: operationContext.limits.coverageExpansion
        ? Math.max(2, Math.min(maxAlternatives, maxScenarios))
        : 1,
      seed,
      pathTypes: pathTypesByKey,
    });
    if (solved.status === 'unsatisfiable' && solved.complete) {
      // For a fully supported and exhausted IR, unsatisfiable is definitive;
      // do not let the fallback invent a candidate for an impossible path.
      continue;
    }
    if (solved.status !== 'solved') {
      operationContext.events.recordConstraintFallback(`${solved.status}: ${solved.reason ?? 'no reason supplied'}`);
      return null;
    }
    if (solved.truncated || !solved.complete || solved.solutions.length > maxAlternatives) {
      operationContext.events.incrementConstraintStat('irTruncated');
      operationContext.events.recordConstraintFallback('IR multi-result search exceeded the complete scenario-alternative budget');
      return null;
    }

    for (let solutionIndex = 0; solutionIndex < solved.solutions.length; solutionIndex += 1) {
      const assignmentSet = solved.solutions[solutionIndex];
      const constrainedClausePaths = new Set((solved.solutionPaths?.[solutionIndex] ?? orderedPaths).map(path => JSON.stringify(path)));
      // The solver starts from the incoming seed. Parent-path candidates can
      // replace child values, so verify every incoming assignment survives
      // before converting the result back to assignment DTOs.
      const solutionDomains = solved.solutionDomains?.[solutionIndex] ?? [];
      const seedPreserved = incomingSnapshots.every(snapshot => {
        const after = readConstraintPath(assignmentSet, snapshot.path);
        const refinesParentObject = orderedPaths.some(path => isStrictPathPrefix(snapshot.path, path)) &&
          snapshot.value.exists && after.exists &&
          snapshot.value.value !== null && typeof snapshot.value.value === 'object' &&
          after.value !== null && typeof after.value === 'object' &&
          Array.isArray(snapshot.value.value) === Array.isArray(after.value);
        const refinesLengthDomain = Boolean(snapshot.assignment.lengthConstraint && solutionDomains.some(domain =>
          domain.kind === 'integer-length' && JSON.stringify(domain.path) === JSON.stringify(snapshot.path)));
        return refinesLengthDomain || refinesParentObject ||
          (snapshot.value.exists === after.exists && sameValue(snapshot.value.value, after.value));
      });
      if (!seedPreserved) {
        // This incoming path is a valid but different representative (e.g.
        // left > right) that cannot satisfy the next condition (left === right).
        // Skip this path and test the remaining incoming witnesses; fall back
        // only when none of them can be preserved.
        rejectedIncomingCandidate = true;
        continue;
      }

      const assignments = new Map();
      for (const path of orderedPaths) {
        if (!constrainedClausePaths.has(JSON.stringify(path))) continue;
        const found = readConstraintPath(assignmentSet, path);
        const { type } = constraintPathHint(path, operationContext, node);
        if (type && !isDefinitelyAssignable(found.value, type)) {
          operationContext.events.recordConstraintFallback(`Solver candidate is incompatible with TypeScript type at ${path.join('.')}`);
          return null;
        }
        const existingLength = incomingAssignments.find(item => JSON.stringify(item.path) === JSON.stringify(path) && item.lengthConstraint);
        const lengthDomain = solutionDomains.find(domain => domain.kind === 'integer-length' && JSON.stringify(domain.path) === JSON.stringify(path));
        if (lengthDomain) {
          const assignment = lengthConstraintFromDomain(lengthDomain, found.value);
          if (!assignment) {
            operationContext.events.recordConstraintFallback(`Could not convert the IR length domain at ${path.join('.')} into a safe length assignment.`);
            return null;
          }
          assignments.set(path.join('.'), assignment);
        } else if (existingLength) {
          // Keep the earlier symbolic length restriction. A plain materialized
          // array/string assignment would erase its mergeable interval.
          continue;
        } else {
          const assignment = makeAssignment(path, found.value).assignments.values().next().value;
          assignments.set(path.join('.'), assignment);
        }
      }
      results.push({ assignments, unsupported: [] });
      if (results.length > maxAlternatives) {
        operationContext.events.recordConstraintFallback('IR multi-result cross-product exceeded the configured scenario-alternative budget');
        return null;
      }
    }
  }

  if (!results.length && rejectedIncomingCandidate) {
    operationContext.events.recordConstraintFallback('All IR candidates would overwrite an incoming ancestor/descendant path assignment');
    return null;
  }

  operationContext.events.incrementConstraintStat('irSolved', results.length);
  operationContext.events.incrementConstraintStat('irSolutionCount', results.length);
  return results;
}


  function solveCondition(node, desired, operationContext, incomingSolutions = null) {
      const hasKnownAliases = [...operationContext.paths.pathAliases.values()].some(alias => ['constant', 'object', 'computed', 'path'].includes(alias?.kind));
    const effectiveNode = hasKnownAliases ? substituteKnownAliases(node, operationContext.paths.pathAliases) : node;
    const staticValue = evaluateStaticCondition(effectiveNode);
    if (staticValue !== null) return staticValue === desired ? [{ assignments: new Map(), unsupported: [] }] : [];
    const current = unwrap(effectiveNode);
    if (!current) return unsupportedSolution('Empty condition');

    const irSolutions = trySolveWithConstraintIR(effectiveNode, desired, operationContext, incomingSolutions);
    if (irSolutions !== null) return irSolutions;
    return recursiveAstFallbackAdapter.solve(current, desired, operationContext, (child, childDesired, childOperationContext = operationContext, childIncoming = null) =>
      solveCondition(child, childDesired, childOperationContext, childIncoming));
  }

  return Object.freeze({ solveCondition, trySolveWithConstraintIR });
}
