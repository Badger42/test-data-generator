import { createScenarioDeduplicator } from './scenario-deduplicator.mjs';
import { createScenarioFingerprint } from './scenario-fingerprint.mjs';

/** Scenario production boundary; all compiler/solver/AST operations are injected. */
export function createScenarioGenerationService(dependencies) {
  const {
    getBranchId, solveCondition, combineSolutions, recordUnsupportedBranch, recordBranchOutcome,
    clearUnsupportedBranch, recordScenario, assignmentMaterializer, defaultValueForType,
    mockPlanner, scenarioEvidenceBuilder, scenarioBuilder, scenarioReportAdapter, mockReportAdapter, formatLine, formatNodeSpan,
    cloneJson, applyAssignment, serializable,
  } = dependencies;
  if (typeof solveCondition !== 'function' || typeof recordScenario !== 'function' || !scenarioBuilder || !scenarioReportAdapter || !mockReportAdapter) {
    throw new TypeError('ScenarioGenerationService requires solver, state and ScenarioBuilder ports.');
  }

function readScenarioArgument(fact, args, parameterMap) {
  if (Object.prototype.hasOwnProperty.call(fact, 'value')) return { resolved: true, value: fact.value };
  if (fact.kind === 'path' && fact.path?.length) {
    const [root, ...segments] = fact.path;
    const parameter = parameterMap.get(root);
    if (!parameter) return { resolved: false };
    let value = args[parameter.index];
    for (const segment of segments) {
      if (value == null) return { resolved: false };
      value = value[segment];
    }
    return value === undefined ? { resolved: false } : { resolved: true, value };
  }
  return { resolved: false };
}

function projectExternalCalls(ctx, args, scenarioMocks = []) {
  const templatesBySite = new Map((ctx.mockTemplates ?? []).map(template => [template.callSiteId, template]));
  return (ctx.mockCallSites ?? []).map(site => {
    const template = templatesBySite.get(site.callSiteId);
    const assigned = scenarioMocks.find(mock => mock.callSiteId && mock.callSiteId === site.callSiteId)
      ?? scenarioMocks.find(mock => (mock.callExpression ?? mock.call ?? mock.callId) === site.callExpression);
    const hasAssignedValue = Boolean(assigned && (
      Object.prototype.hasOwnProperty.call(assigned, 'value') ||
      Object.prototype.hasOwnProperty.call(assigned, 'resolvedValue')
    ));
    const suggestedValues = template?.suggestedResolvedValues ?? [];
    const value = hasAssignedValue
      ? (Object.prototype.hasOwnProperty.call(assigned, 'value') ? assigned.value : assigned.resolvedValue)
      : suggestedValues[0] ?? null;
    return {
      call: site.callExpression,
      callId: site.callId,
      callSiteId: site.callSiteId,
      ...(site.mockTarget ? { mockTarget: site.mockTarget } : {}),
      sourceSpan: site.sourceSpan,
      classification: site.classification?.kind ?? 'external-dependency',
      executionContext: site.executionContext ?? 'function-body',
      reachability: site.reachability ?? 'direct-static-call-site',
      ...(site.functionScope ? { functionScope: site.functionScope } : {}),
      callArguments: (site.argumentFacts ?? []).map(fact => {
        const resolved = readScenarioArgument(fact, args, ctx.parameterMap);
        return {
          index: fact.index,
          expression: fact.expressionText,
          kind: fact.kind,
          ...(fact.path ? { path: fact.path } : {}),
          ...(resolved.resolved ? { value: resolved.value, resolvedFromScenario: true } : { resolvedFromScenario: false }),
          confidence: fact.confidence,
        };
      }),
      mock: {
        behavior: assigned?.behavior ?? template?.mockBehavior ?? (site.isPromise ? 'mockResolvedValue' : 'mockReturnValue'),
        ...(value !== undefined ? { value } : {}),
        source: hasAssignedValue ? 'scenario-solver-assignment' : 'type-derived-suggestion',
        confidence: hasAssignedValue ? 'solver-candidate' : 'type-derived-candidate',
        appliedAutomatically: false,
        adapterSupport: site.mockTarget?.support ?? 'manual-setup-required',
        setupRequired: site.mockTarget?.support !== 'automatic',
      },
    };
  });
}

function addScenarios(ctx, kind, node, conditionText, desired, incoming, targetLabel = null, solveNode = node, targetMetadata = {}) {
  const branchId = getBranchId(kind, node, ctx.sourceFile);
  const metadata = { ...ctx.activeAnalysisMetadata, ...targetMetadata };
  const publicMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => !['callbackDescriptor', 'callbackNode', 'callbackBaseIncoming', 'callbackUsesIndex', 'callbackSourceExpression'].includes(key)));
  const iterationKey = metadata.iterationIndex === undefined ? '' : `:iteration-${metadata.iterationIndex}${metadata.reduceStateKey ? `:state-${metadata.reduceStateKey}` : ''}`;
  const branchKey = `${branchId}:${desired}:${targetLabel ?? ''}${iterationKey}`;
  if (ctx.branchSeen.has(branchKey)) return;
  ctx.branchSeen.add(branchKey);
  const outcomeKey = `${branchId}:${desired}:${targetLabel ?? ''}`;
  const targetSolutions = solveCondition(solveNode, desired, ctx, incoming);
  const candidateSolutions = combineSolutions(incoming, targetSolutions, ctx.maxAlternatives);
  const unsupportedSolutions = candidateSolutions.filter(solution => solution.unsupported?.length);
  const fullSolutions = candidateSolutions.filter(solution => !solution.unsupported?.length);
  if (!fullSolutions.length) {
    if (!ctx.branchOutcomeSeen.has(outcomeKey)) {
      const reasons = [...new Set(unsupportedSolutions.flatMap(solution => solution.unsupported ?? []))];
      recordUnsupportedBranch(ctx, { branchId, outcome: desired, reason: reasons.length ? reasons.join('; ') : 'No consistent assignment found for this path/context.' });
    }
    return;
  }
  if (!ctx.branchOutcomeSeen.has(outcomeKey)) {
    ctx.branchOutcomeSeen.add(outcomeKey);
    recordBranchOutcome(ctx, branchId, desired, outcomeKey);
  }
  // A callback branch may be impossible for index 0 but reachable at index 1.
  // Once any supported callback context solves it, do not report it as unsupported.
  clearUnsupportedBranch(ctx, branchId, desired);
  let index = 0;
  const deduplicator = createScenarioDeduplicator();
  for (const solution of fullSolutions) {
    if (index >= ctx.maxScenarios) break;
    const materialized = assignmentMaterializer.materialize({
      baseArguments: ctx.baseArgs,
      assignments: solution.assignments,
      parameterMap: ctx.parameterMap,
      localMockMap: ctx.localMockMap,
      getParameterDefault: parameter => defaultValueForType(parameter.type, ctx.checker, node),
      getMockDefault: binding => defaultValueForType(binding.resolvedType, ctx.checker, node),
    });
    const normalizedArgs = materialized.arguments;
    const mockPlan = mockPlanner.plan({
      mockAssignments: materialized.mockAssignments,
      behaviorOverrides: ctx.mockBehaviorOverrides,
      callSites: ctx.mockCallSites,
      dataFlowModel: ctx.dataFlowModel,
    });
    const normalizedMocks = mockReportAdapter.project(mockPlan);
    const domainMocks = mockPlanner.toScenarioMocks(mockPlan);
    // Evidence is metadata, not scenario identity: deduplicate using behavior/value only.
    const claim = deduplicator.claim({ arguments: normalizedArgs, mocks: normalizedMocks });
    if (claim.duplicate) continue;
    if (ctx.includeEvidence) {
      for (let mockIndex = 0; mockIndex < normalizedMocks.length; mockIndex += 1) {
        const action = mockPlan.actions?.[mockIndex];
        if (!action) continue;
        if (action.inputDependencies?.length) normalizedMocks[mockIndex].inputDependencies = action.inputDependencies;
        if (action.dataFlowEffects?.length) normalizedMocks[mockIndex].dataFlowEffects = action.dataFlowEffects;
        if (action.contextIds?.length) normalizedMocks[mockIndex].contextIds = action.contextIds;
        if (action.evidence?.length) normalizedMocks[mockIndex].evidence = action.evidence;
      }
    }
    index += 1;
    const position = formatLine(ctx.sourceFile, node);
    const sourceSpan = formatNodeSpan(ctx.sourceFile, node);

    const id = `${branchId}-${desired ? 'true' : 'false'}${metadata.iterationIndex === undefined ? '' : `-iteration-${metadata.iterationIndex}`}-${index}`;
    const target = {
      branchId,
      kind,
      line: position.line,
      column: position.column,
      ...sourceSpan,
      ...(typeof desired === 'boolean' ? { coverageOutcomeIndex: desired ? 0 : 1 } : {}),
      condition: conditionText,
      outcome: desired,
      ...(targetLabel ? { label: targetLabel } : {}),
      ...publicMetadata,
    };
    const evidence = scenarioEvidenceBuilder.build({
      incoming,
      assignments: solution.assignments,
      unsupported: solution.unsupported,
      dataFlowModel: ctx.dataFlowModel,
      sourceSpan,
      target: { branchId, kind, outcome: desired },
    });
    const domainScenario = scenarioBuilder.build({
      id,
      functionId: ctx.fn.functionId ?? `${ctx.sourceFile.fileName}::${ctx.fn.name}@${ctx.fn.node.getStart(ctx.sourceFile)}`,
      arguments: normalizedArgs,
      mocks: domainMocks,
      targets: [{ branchId, outcome: desired }],
      assumptions: evidence.assumptions,
      warnings: evidence.warnings,
      evidence: evidence.evidence,
      fingerprint: claim.fingerprint,
    });
    const scenario = scenarioReportAdapter.project(domainScenario, {
      target,
      mocks: normalizedMocks,
      unsupported: solution.unsupported,
      includeEvidence: ctx.includeEvidence,
    });
    const externalCalls = projectExternalCalls(ctx, normalizedArgs, domainMocks);
    recordScenario(ctx, externalCalls.length ? { ...scenario, externalCalls } : scenario, { loop: kind === 'loop' });
  }
  if (unsupportedSolutions.length) {
    recordUnsupportedBranch(ctx, { branchId, outcome: desired, reason: [...new Set(unsupportedSolutions.flatMap(solution => solution.unsupported ?? []))].join('; ') });
  }
}

function addCustomSwitchScenario(ctx, branchId, condition, label, solutions, node, switchStatement, coverageOutcomeIndex) {
  const rejectedSolutions = solutions.filter(solution => solution.unsupported?.length);
  solutions = solutions.filter(solution => !solution.unsupported?.length);
  if (!solutions.length && rejectedSolutions.length) {
    recordUnsupportedBranch(ctx, { branchId, outcome: label, reason: [...new Set(rejectedSolutions.flatMap(solution => solution.unsupported ?? []))].join('; ') });
    return;
  }
  let index = 0;
  const seen = new Set();
  for (const solution of solutions) {
    if (index >= ctx.maxScenarios) break;
    const args = cloneJson(ctx.baseArgs);
    const mockValues = new Map();
    for (const assignment of solution.assignments.values()) applyAssignment(args, assignment, ctx.parameterMap, ctx.localMockMap, ctx.checker, node, mockValues);
    const normalizedArgs = serializable(args);
    const normalizedMocks = [...mockValues.values()].map(mock => ({ ...mock, resolvedValue: serializable(mock.resolvedValue) }));
    const fingerprint = createScenarioFingerprint({ arguments: normalizedArgs, mocks: normalizedMocks });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    index += 1;
    const position = formatLine(ctx.sourceFile, node);
    const sourceSpan = formatNodeSpan(ctx.sourceFile, node);
    const switchPosition = formatLine(ctx.sourceFile, switchStatement ?? node);
    const switchSpan = formatNodeSpan(ctx.sourceFile, switchStatement ?? node);
    const scenario = {
      id: `${branchId}-${index}`,
      target: { branchId, kind: 'switch', line: position.line, column: position.column, ...sourceSpan, coverageLine: switchPosition.line, coverageColumn: switchPosition.column, coverageStartOffset: switchSpan.startOffset, coverageEndOffset: switchSpan.endOffset, coverageOutcomeIndex, condition, outcome: label },
      arguments: normalizedArgs,
      ...(normalizedMocks.length ? { mocks: normalizedMocks } : {}),
      assumptions: [...solution.assignments.keys()],
      unsupported: solution.unsupported,
    };
    const externalCalls = projectExternalCalls(ctx, normalizedArgs, normalizedMocks);
    recordScenario(ctx, externalCalls.length ? { ...scenario, externalCalls } : scenario);
  }
  if (rejectedSolutions.length) recordUnsupportedBranch(ctx, { branchId, outcome: label, reason: [...new Set(rejectedSolutions.flatMap(solution => solution.unsupported ?? []))].join('; ') });
}

function addLoopScenario(ctx, node, loopType, condition, outcome, solutions, metadata = {}) {
  const branchId = getBranchId('loop', node, ctx.sourceFile);
  const branchKey = `${branchId}:${String(outcome)}`;
  if (ctx.branchSeen.has(branchKey)) return;
  ctx.branchSeen.add(branchKey);
  recordBranchOutcome(ctx, branchId, outcome, branchKey);
  const rejectedSolutions = solutions.filter(solution => solution.unsupported?.length);
  solutions = solutions.filter(solution => !solution.unsupported?.length);
  if (!solutions.length) {
    const reasons = [...new Set(rejectedSolutions.flatMap(solution => solution.unsupported ?? []))];
    recordUnsupportedBranch(ctx, { branchId, outcome, reason: reasons.length ? reasons.join('; ') : 'No consistent input assignment could be constructed for this loop outcome.' });
    return;
  }

  let index = 0;
  const seen = new Set();
  for (const solution of solutions) {
    if (index >= ctx.maxScenarios) break;
    const args = cloneJson(ctx.baseArgs);
    const mockValues = new Map();
    for (const assignment of solution.assignments.values()) {
      applyAssignment(args, assignment, ctx.parameterMap, ctx.localMockMap, ctx.checker, node, mockValues);
    }
    const normalizedArgs = serializable(args);
    const normalizedMocks = [...mockValues.values()].map(mock => ({ ...mock, resolvedValue: serializable(mock.resolvedValue) }));
    const fingerprint = createScenarioFingerprint({ arguments: normalizedArgs, mocks: normalizedMocks });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    index += 1;
    const position = formatLine(ctx.sourceFile, node);
    const sourceSpan = formatNodeSpan(ctx.sourceFile, node);
    const scenario = {
      id: `${branchId}-${String(outcome).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${index}`,
      target: {
        branchId,
        kind: 'loop',
        loopType,
        line: position.line,
        column: position.column,
        ...sourceSpan,
        ...(typeof outcome === 'boolean' ? { coverageOutcomeIndex: outcome ? 0 : 1 } : {}),
        condition,
        outcome,
        ...metadata,
      },
      arguments: normalizedArgs,
      ...(normalizedMocks.length ? { mocks: normalizedMocks } : {}),
      assumptions: [...solution.assignments.keys()],
      unsupported: solution.unsupported,
    };
    const externalCalls = projectExternalCalls(ctx, normalizedArgs, normalizedMocks);
    recordScenario(ctx, externalCalls.length ? { ...scenario, externalCalls } : scenario, { loop: true });
  }
  if (rejectedSolutions.length) {
    recordUnsupportedBranch(ctx, {
      branchId,
      outcome,
      reason: [...new Set(rejectedSolutions.flatMap(solution => solution.unsupported ?? []))].join('; '),
    });
  }
}

  return Object.freeze({ addScenarios, addCustomSwitchScenario, addLoopScenario });
}
