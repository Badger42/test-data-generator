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
        stopReason = feedback.status.startsWith('jest-') ? feedback.status : `jest-${feedback.status}`;
        break;
      }

      const branchPct = feedback.totals?.branches?.pct;
      if (branchPct !== null && branchPct !== undefined && branchPct >= args.coverageGoal) {
        stopReason = 'coverage-goal-reached';
        break;
      }

      const missingOutcomeKeys = collectUncoveredStaticOutcomeKeys(feedback);
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
      goalReached: Boolean(feedback.totals?.branches?.pct != null && feedback.totals.branches.pct >= args.coverageGoal),
      note: 'Each pass expands solver alternatives only for static branch outcomes still uncovered according to the preceding Istanbul report. The full accumulated scenario set is re-executed on every pass. This is bounded candidate expansion, not unrestricted symbolic execution.',
    };
    return feedback;
  }

  return { runIterativeCoverageFeedback, execute: runIterativeCoverageFeedback };
}
