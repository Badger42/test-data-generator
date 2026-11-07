/**
 * Application coordinator for bounded, targeted coverage expansion.
 * Static analysis and execution are injected ports; the use case owns only the
 * iteration policy, cumulative-suite semantics and final minimization step.
 */
import {
  collectUncoveredStaticOutcomeKeys,
  mergeExpandedFunctionAnalysis,
  summarizeCoverageIteration,
} from '../coverage/coverage-feedback-iteration.mjs';

function collectUnverifiableStaticTargets(feedback) {
  return (feedback?.staticBranchTargets ?? []).filter(target => {
    if (target.coverageApplicable === false || target.coverageStatus === 'not-applicable') return false;
    if (target.coverageStatus === 'not-mapped' || target.coverageStatus === 'ambiguous') return true;
    // Null/undefined means this provider or mapping did not establish an
    // individual semantic outcome (for example a V8 if-condition range).
    return (target.outcomes ?? []).some(outcome => outcome.covered == null);
  });
}

export function createIterativeCoverageFeedbackUseCase({
  createCoverageFeedback,
  analyzeFunction,
  buildMinimalTestSet,
  maxAlternativesPerPass = 512,
}) {
  if (typeof createCoverageFeedback !== 'function') throw new TypeError('createCoverageFeedback must be a function.');
  if (typeof analyzeFunction !== 'function') throw new TypeError('analyzeFunction must be a function.');
  if (typeof buildMinimalTestSet !== 'function') throw new TypeError('buildMinimalTestSet must be a function.');
  if (!Number.isInteger(maxAlternativesPerPass) || maxAlternativesPerPass < 1) {
    throw new TypeError('maxAlternativesPerPass must be a positive integer.');
  }

  function runIterativeCoverageFeedback(result, selectedFunctionNodes, sourceFile, outputFile, args, checker, sourceFileNode) {
    const history = [];
    let currentMaxScenarios = args.maxScenarios;
    let stopReason = 'max-iterations-reached';
    let feedback = null;
    let totalAddedScenarios = 0;
    let pendingAddedScenarios = 0;

    if (args.coverageFrom) {
      feedback = createCoverageFeedback(result, sourceFile, outputFile, args);
      if (args.minimalSuite) feedback.minimalTestSet = {
        status: 'unavailable',
        reason: 'External aggregated coverage-final.json does not contain per-scenario runtime traces.',
      };
      feedback.iterative = {
        enabled: false,
        stopReason: 'external-coverage-is-read-only',
        maxIterations: 0,
        iterations: [],
        note: 'An existing coverage-final.json was loaded. Iterative execution requires --coverage-feedback without --coverage-from.',
      };
      return feedback;
    }

    for (let iteration = 1; iteration <= args.coverageIterations; iteration += 1) {
      feedback = createCoverageFeedback(result, sourceFile, outputFile, args);
      const scenarioCount = result.functions.reduce((total, fn) => total + (fn.scenarios?.length ?? 0), 0);
      history.push(summarizeCoverageIteration(feedback, iteration, scenarioCount, pendingAddedScenarios));
      pendingAddedScenarios = 0;

      if (feedback.status !== 'passed') {
        stopReason = feedback.status === 'execution-timeout' || feedback.status.startsWith('jest-')
          ? feedback.status : `jest-${feedback.status}`;
        break;
      }

      const branchPct = feedback.totals?.branches?.pct;
      const aggregateGoalReached = branchPct !== null && branchPct !== undefined && branchPct >= args.coverageGoal;
      const missingOutcomeKeys = collectUncoveredStaticOutcomeKeys(feedback);
      const unverifiableTargets = collectUnverifiableStaticTargets(feedback);

      // Aggregate Istanbul counters are not sufficient evidence for semantic
      // branch outcomes. In particular, Jest's V8 provider reports one counter
      // for an if-condition range, so it cannot prove separate true/false paths.
      // Do not stop early when mapped outcomes remain measurable but uncovered;
      // do stop without expanding when the selected provider cannot distinguish
      // the outstanding outcomes at all.
      if (aggregateGoalReached && missingOutcomeKeys.size === 0 && unverifiableTargets.length === 0) {
        stopReason = 'coverage-goal-reached';
        break;
      }
      if (aggregateGoalReached && unverifiableTargets.length > 0) {
        stopReason = 'coverage-goal-unverifiable-with-current-provider';
        break;
      }

      if (!missingOutcomeKeys.size) {
        const unmapped = feedback.branchCoverage?.staticTargetsUnmapped ?? 0;
        const ambiguous = feedback.branchCoverage?.staticTargetsAmbiguous ?? 0;
        const notApplicable = feedback.branchCoverage?.staticTargetsNotApplicable ?? 0;
        const mapped = feedback.branchCoverage?.staticTargetsCovered ?? 0;
        stopReason = ambiguous > 0 ? 'remaining-targets-ambiguous-in-istanbul-map'
          : unmapped > 0 ? 'remaining-targets-not-mapped-to-istanbul'
          : mapped === 0 && notApplicable > 0 ? 'no-instrumentable-static-branch-targets'
          : 'all-mapped-static-targets-covered';
        break;
      }

      if (iteration >= args.coverageIterations) {
        stopReason = 'max-iterations-reached';
        break;
      }

      const nextMaxScenarios = Math.min(currentMaxScenarios * 2, maxAlternativesPerPass);
      if (nextMaxScenarios <= currentMaxScenarios) {
        stopReason = 'scenario-search-limit-reached';
        break;
      }

      const nextMaxAlternatives = Math.min(maxAlternativesPerPass, Math.max(40, nextMaxScenarios));
      let addedThisPass = 0;
      const expandedFunctions = selectedFunctionNodes.map((node, index) => {
        const expanded = analyzeFunction(node, sourceFileNode, checker, nextMaxScenarios, args.mcdc, {
          constraintEngine: args.constraintEngine ?? 'hybrid',
          mockBehaviorOverrides: args.mockBehaviorOverrides ?? {},
          mockExclusions: args.mockExclusions ?? {},
          coverageExpansion: true,
          maxAlternatives: nextMaxAlternatives,
        });
        const merged = mergeExpandedFunctionAnalysis(result.functions[index], expanded, missingOutcomeKeys, iteration + 1);
        addedThisPass += merged.feedbackScenariosAdded;
        delete merged.feedbackScenariosAdded;
        return merged;
      });

      if (!addedThisPass) {
        stopReason = 'no-new-candidates-for-uncovered-outcomes';
        break;
      }

      result.functions = expandedFunctions;
      currentMaxScenarios = nextMaxScenarios;
      totalAddedScenarios += addedThisPass;
      pendingAddedScenarios = addedThisPass;
      // Re-run the full accumulated suite on the following pass so the final
      // Istanbul map always represents all currently retained candidates.
    }

    if (args.minimalSuite) {
      feedback.minimalTestSet = buildMinimalTestSet(
        feedback?.execution?.scenarioCoverage,
        feedback?.staticBranchTargets ?? [],
        feedback?.execution?.mcdcPairs ?? [],
      );
    }

    const aggregateGoalReached = feedback?.status === 'passed' &&
      feedback.totals?.branches?.pct != null && feedback.totals.branches.pct >= args.coverageGoal;
    const remainingOutcomeKeys = collectUncoveredStaticOutcomeKeys(feedback);
    const unverifiableTargets = collectUnverifiableStaticTargets(feedback);
    const staticBranchOutcomesVerified = feedback?.status === 'passed' &&
      remainingOutcomeKeys.size === 0 && unverifiableTargets.length === 0;

    feedback.iterative = {
      enabled: true,
      strategy: 'targeted-static-branch-expansion',
      maxIterations: args.coverageIterations,
      coverageGoalPct: args.coverageGoal,
      initialMaxScenarios: args.maxScenarios,
      finalMaxScenarios: currentMaxScenarios,
      totalAdditionalScenarios: totalAddedScenarios,
      iterations: history,
      stopReason,
      aggregateGoalReached: Boolean(aggregateGoalReached),
      staticBranchOutcomesVerified: Boolean(staticBranchOutcomesVerified),
      unverifiableStaticTargets: unverifiableTargets.map(target => ({
        id: target.id,
        coverageStatus: target.coverageStatus ?? 'unknown',
        mappingStatus: target.mappingStatus ?? 'unknown',
      })),
      // The public goal is met only when both the aggregate percentage and
      // semantic static-target checks are satisfied.
      goalReached: Boolean(aggregateGoalReached && staticBranchOutcomesVerified),
      note: 'Aggregate Istanbul percentages and semantic static branch outcomes are reported independently. V8 condition-range counters cannot prove individual if true/false outcomes. Each pass re-executes the accumulated scenario set; this is bounded candidate expansion, not unrestricted symbolic execution.',
    };
    return feedback;
  }

  return { runIterativeCoverageFeedback, execute: runIterativeCoverageFeedback };
}
