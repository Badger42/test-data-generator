#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { VERSION } from '../domain/version.mjs';
import { compileTypescriptCondition } from '../constraints/compile-typescript-condition.mjs';
import { collectConstraintPaths, createConstraintIR, logical, negate } from '../constraints/constraint-ir.mjs';
import { createExpressionAliasResolver } from '../data-flow/typescript-expression-facts.mjs';
import { createTypeScriptDataFlowAnalyzer } from '../data-flow/data-flow-analyzer.mjs';
import { ConstraintSolver } from '../solver/constraint-solver.mjs';
import { formatLine, formatNodeSpan, coverageAnchorMetadata } from '../ast/source-spans.mjs';
import { createAstFacade } from '../ast/ast-facade.mjs';
import { createPathResolver } from '../ast/path-resolver.mjs';
import { createTypeModelProvider } from '../inference/type-model-provider.mjs';
import { createPropertyInference } from '../inference/property-inference.mjs';
import { createFunctionContextBuilder } from '../analysis/function-context-builder.mjs';
import { createControlFlowAnalyzer } from '../analysis/control-flow/control-flow-analyzer.mjs';
import { createLoopProgressAnalyzer } from '../analysis/loops/loop-progress-analyzer.mjs';
import { createExpressionTraversal } from '../analysis/ast-traversal/expression-traversal.mjs';
import { createFunctionAnalysisOrchestrator } from '../analysis/function-analysis-orchestrator.mjs';
import { createArrayPipelineRuntime } from '../analysis/arrays/array-pipeline-runtime.mjs';
import { createCallbackExpressionUtils } from '../analysis/arrays/callback-expression-utils.mjs';
import { createArrayCallbackAnalyzer } from '../analysis/arrays/array-callback-analyzer.mjs';
import { createReduceStateInterpreter } from '../analysis/arrays/reduce-state-interpreter.mjs';
import {
  ARRAY_CALLBACK_METHODS, ARRAY_REDUCE_METHODS, ARRAY_COMPARATOR_METHODS, getArrayPipelineResultKind,
} from '../domain/array-method-policy.mjs';
import { createUndefinedValueSerializer } from '../scenarios/serializers/undefined-value.mjs';
import { createAssignmentMaterializer } from '../scenarios/assignment-materializer.mjs';
import { createScenarioEvidenceBuilder } from '../scenarios/scenario-evidence-builder.mjs';
import { createScenarioBuilder } from '../scenarios/scenario-builder.mjs';
import { createScenarioGenerationService } from '../scenarios/scenario-generation-service.mjs';
import { createScenarioReportAdapter } from '../reporting/scenario-report-adapter.mjs';
import { createMockReportAdapter } from '../reporting/mock-report-adapter.mjs';
import { createDependencyDiscovery } from '../mocks/dependency-discovery.mjs';
import { createMockTemplateBuilder } from '../mocks/mock-template-builder.mjs';
import { createMockStatePlanner } from '../mocks/mock-state-planner.mjs';
import { createMockPlanner } from '../mocks/mock-planner.mjs';
import { createMcdcDecisionExtractor } from '../mcdc/static/decision-extractor.mjs';
import { planUniqueCauseCandidates, verifyUniqueCauseCandidate } from '../mcdc/static/pair-planner.mjs';
import { createMcdcPairFeasibilityVerifier } from '../mcdc/static/pair-feasibility-verifier.mjs';
import { createMcdcScenarioMaterializer } from '../mcdc/static/scenario-materializer.mjs';
import { createFunctionAnalysisStateStore } from '../analysis/analysis-state-store.mjs';
import { createAnalysisOperationContext, deriveAnalysisOperationContext } from '../analysis/analysis-operation-context.mjs';
import { createConstraintAnalysisService } from '../solver/constraint-analysis-service.mjs';
import { createRecursiveAstFallbackAdapter } from '../solver/recursive-ast-fallback.mjs';
import { createMcdcAnalysisOrchestrator } from '../mcdc/mcdc-analysis-orchestrator.mjs';
import { createCoverageFeedbackRuntime } from './coverage-feedback-runtime.mjs';

const callbackExpressionUtils = createCallbackExpressionUtils(ts);
const {
  isFunctionLikeCallback, isSafeCallbackLocalInitializer, isReplaceableCallbackIdentifier,
  substituteCallbackLocals, getCallbackLocalDefinitions, expandCallbackLocalVariables,
  getCallbackPredicateSourceExpression, getCallbackPredicateExpression, getNodeText,
} = callbackExpressionUtils;
const MAX_MCDC_ATOMS = 10;
const MAX_MCDC_COMBINATIONS = 512;
const UNDEFINED = Symbol('undefined');
const undefinedValueSerializer = createUndefinedValueSerializer({ undefinedValue: UNDEFINED });
const assignmentMaterializer = createAssignmentMaterializer({
  cloneValue: cloneJson,
  serializeValue: value => undefinedValueSerializer.serialize(value),
  isUndefined: value => value === UNDEFINED || value === undefined,
  materializeLengthConstraint,
  materializeNumericConstraint,
});
const scenarioEvidenceBuilder = createScenarioEvidenceBuilder();
const scenarioBuilder = createScenarioBuilder({ evidenceBuilder: scenarioEvidenceBuilder });
const scenarioReportAdapter = createScenarioReportAdapter();
const mockReportAdapter = createMockReportAdapter();
const typeModelProvider = createTypeModelProvider(ts);
const {
  typeHasFlag, unionMembers, nonNullishType, hasTypeFlagInUnion,
  literalForType, defaultValueForType, getTypeAtPath: typeAtPath,
  classifyType: classifyKnownType,
} = typeModelProvider;
const dependencyDiscovery = createDependencyDiscovery(ts);
const mockTemplateBuilder = createMockTemplateBuilder({
  unionMembers,
  defaultValueForType,
  serialize: value => undefinedValueSerializer.serialize(value),
});
const mockStatePlanner = createMockStatePlanner();
const mockPlanner = createMockPlanner({ dependencyDiscovery, templateBuilder: mockTemplateBuilder, statePlanner: mockStatePlanner });
const astFacade = createAstFacade(ts);
const pathResolver = createPathResolver({ ts, astFacade, undefinedValue: UNDEFINED });
const {
  unwrapExpression: unwrap,
  getPath,
  getPathWithAliases,
  getTwoPathsWithAliases,
  createPathAccessNode,
  applyPropertyTail,
  getLoopVariableName,
  getLoopInitialValue,
  findLengthCollectionPath,
  substituteIdentifiers,
  substituteKnownAliases,
} = pathResolver;
const getPathAndLiteralWithAliases = (left, right, aliases = new Map()) =>
  pathResolver.getPathAndLiteralWithAliases(left, right, aliases, UNDEFINED);
const getLiteral = node => astFacade.readLiteral(node, UNDEFINED);
const loopProgressAnalyzer = createLoopProgressAnalyzer({ ts, unwrap, getLiteral, invertRelationalOperator });
const {
  applyLoopIncrementor, applyNumericUpdates, hasSimpleLoopProgress,
  loopProgressesTowardExit, localCounterProgressesTowardExit,
} = loopProgressAnalyzer;
const typeScriptDataFlowAnalyzer = createTypeScriptDataFlowAnalyzer(ts);
let DEFAULT_MAX_ALTERNATIVES = 40;

/** Compatibility configuration for callers that do not provide a session limit. */
export function setMaxAlternatives(value) {
  DEFAULT_MAX_ALTERNATIVES = Math.min(512, Math.max(1, Number(value) || 40));
}

function chooseDifferent(value, type) {
  const unionCandidates = unionMembers(type).map(literalForType).filter(candidate => candidate !== undefined);
  const otherUnionValue = unionCandidates.find(candidate => !sameValue(candidate, value));
  if (otherUnionValue !== undefined) return otherUnionValue;
  if (value === UNDEFINED || value === null) {
    if (type && hasTypeFlagInUnion(type, ts.TypeFlags.StringLike)) return 'test';
    if (type && hasTypeFlagInUnion(type, ts.TypeFlags.NumberLike)) return 1;
    if (type && hasTypeFlagInUnion(type, ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) return true;
    return {};
  }
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}_other`;
  return null;
}

function differentLiteralCandidates(value, type) {
  const candidates = unionMembers(type)
    .map(literalForType)
    .filter(candidate => candidate !== undefined && !sameValue(candidate, value));
  const unique = [...new Map(candidates.map(candidate => [JSON.stringify(candidate), candidate])).values()];
  return unique.length ? unique : [chooseDifferent(value, type)];
}

function numericAllowedValues(type) {
  const members = unionMembers(type);
  if (members.length <= 1) return null;
  const values = members.map(literalForType);
  if (values.every(value => typeof value === 'number')) return values;
  return null;
}

function makeNumericAssignment(pathParts, constraint) {
  return {
    assignments: new Map([[pathParts.join('.'), { path: pathParts, numericConstraint: constraint }]]),
    unsupported: [],
  };
}

function satisfiesNumericConstraint(value, constraint) {
  if (constraint.min !== null && (value < constraint.min || (value === constraint.min && !constraint.minInclusive))) return false;
  if (constraint.max !== null && (value > constraint.max || (value === constraint.max && !constraint.maxInclusive))) return false;
  return !constraint.excluded.includes(value);
}

function materializeNumericConstraint(constraint) {
  const candidates = [];
  if (constraint.allowedValues) candidates.push(...constraint.allowedValues);
  if (constraint.min !== null && constraint.max !== null) {
    if (constraint.min === constraint.max) candidates.push(constraint.min);
    else candidates.push((constraint.min + constraint.max) / 2, constraint.min, constraint.max);
  } else if (constraint.min !== null) {
    candidates.push(constraint.minInclusive ? constraint.min : constraint.min + 1, constraint.min + 1, constraint.min + 0.5);
  } else if (constraint.max !== null) {
    candidates.push(constraint.maxInclusive ? constraint.max : constraint.max - 1, constraint.max - 1, constraint.max - 0.5);
  } else candidates.push(0, 1, -1);
  const unique = [...new Set(candidates)];
  return unique.find(value => Number.isFinite(value) && satisfiesNumericConstraint(value, constraint));
}

function mergeNumericConstraints(left, right) {
  let min = left.min;
  let minInclusive = left.minInclusive;
  if (right.min !== null && (min === null || right.min > min || (right.min === min && !right.minInclusive))) {
    min = right.min;
    minInclusive = right.minInclusive;
  } else if (right.min !== null && right.min === min) minInclusive = minInclusive && right.minInclusive;

  let max = left.max;
  let maxInclusive = left.maxInclusive;
  if (right.max !== null && (max === null || right.max < max || (right.max === max && !right.maxInclusive))) {
    max = right.max;
    maxInclusive = right.maxInclusive;
  } else if (right.max !== null && right.max === max) maxInclusive = maxInclusive && right.maxInclusive;

  let allowedValues = null;
  if (left.allowedValues && right.allowedValues) allowedValues = left.allowedValues.filter(value => right.allowedValues.includes(value));
  else allowedValues = left.allowedValues ?? right.allowedValues;
  const merged = { min, minInclusive, max, maxInclusive, excluded: [...new Set([...left.excluded, ...right.excluded])], allowedValues };
  if (allowedValues && !allowedValues.some(value => satisfiesNumericConstraint(value, merged))) return null;
  if (!allowedValues) {
    if (min !== null && max !== null && (min > max || (min === max && (!minInclusive || !maxInclusive)))) return null;
    if (materializeNumericConstraint(merged) === undefined) return null;
  }
  return merged;
}

function makeLengthAssignment(pathParts, min, max, excluded, isArray, itemValue) {
  const lengthConstraint = { min, max, excluded, isArray, itemValue };
  return {
    assignments: new Map([[pathParts.join('.'), { path: pathParts, lengthConstraint }]]),
    unsupported: [],
  };
}

function mergeLengthConstraints(left, right) {
  const min = Math.max(left.min, right.min);
  const max = Math.min(left.max, right.max);
  const excluded = [...new Set([...left.excluded, ...right.excluded])];
  const limit = Math.min(max, 8);
  let possible = false;
  for (let length = min; length <= limit; length += 1) {
    if (!excluded.includes(length)) { possible = true; break; }
  }
  if (min > max || !possible) return null;
  return { ...left, min, max, excluded };
}

function materializeLengthConstraint(constraint) {
  let length = -1;
  for (let candidate = constraint.min; candidate <= Math.min(constraint.max, 8); candidate += 1) {
    if (!constraint.excluded.includes(candidate)) { length = candidate; break; }
  }
  if (length < 0) return null;
  return constraint.isArray
    ? Array.from({ length }, () => cloneJson(constraint.itemValue))
    : 'x'.repeat(length);
}

function normalizeOperator(operator, desired) {
  if (desired) return operator;
  return ({
    [ts.SyntaxKind.EqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsToken,
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
    [ts.SyntaxKind.ExclamationEqualsToken]: ts.SyntaxKind.EqualsEqualsToken,
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ts.SyntaxKind.EqualsEqualsEqualsToken,
    [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanEqualsToken,
    [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanToken,
    [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanEqualsToken,
    [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanToken,
  })[operator] ?? operator;
}

function makeAssignment(pathParts, value) {
  return { assignments: new Map([[pathParts.join('.'), { path: pathParts, value }]]), unsupported: [] };
}

function getPathAndLiteral(left, right) {
  const leftPath = getPath(left);
  const rightLiteral = getLiteral(right);
  if (leftPath && rightLiteral.ok) return { path: leftPath, literal: rightLiteral.value, swapped: false };
  const rightPath = getPath(right);
  const leftLiteral = getLiteral(left);
  if (rightPath && leftLiteral.ok) return { path: rightPath, literal: leftLiteral.value, swapped: true };
  return null;
}

function invertRelationalOperator(operator) {
  return ({
    [ts.SyntaxKind.LessThanToken]: ts.SyntaxKind.GreaterThanToken,
    [ts.SyntaxKind.LessThanEqualsToken]: ts.SyntaxKind.GreaterThanEqualsToken,
    [ts.SyntaxKind.GreaterThanToken]: ts.SyntaxKind.LessThanToken,
    [ts.SyntaxKind.GreaterThanEqualsToken]: ts.SyntaxKind.LessThanEqualsToken,
  })[operator] ?? operator;
}

function isDefinitelyAssignable(value, type) {
  if (!type || typeHasFlag(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  const members = unionMembers(type);
  if (value === UNDEFINED) return members.some(member => typeHasFlag(member, ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  if (value === null) return members.some(member => typeHasFlag(member, ts.TypeFlags.Null));
  if (typeof value === 'string') {
    return members.some(member => typeHasFlag(member, ts.TypeFlags.String) ||
      (typeHasFlag(member, ts.TypeFlags.StringLiteral) && member.value === value));
  }
  if (typeof value === 'number') {
    return members.some(member => typeHasFlag(member, ts.TypeFlags.Number) ||
      (typeHasFlag(member, ts.TypeFlags.NumberLiteral) && member.value === value));
  }
  if (typeof value === 'boolean') {
    return members.some(member => typeHasFlag(member, ts.TypeFlags.Boolean) ||
      (typeHasFlag(member, ts.TypeFlags.BooleanLiteral) && (member.intrinsicName === 'true') === value));
  }
  return members.some(member => typeHasFlag(member, ts.TypeFlags.Object));
}

function comparisonAssignment(pathParts, literal, operator, desired, parameterMap, localMockMap, checker, location, inferredPaths) {
  let op = normalizeOperator(operator, desired);
  if (literal === UNDEFINED && (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)) {
    op = op === ts.SyntaxKind.EqualsEqualsToken ? ts.SyntaxKind.EqualsEqualsEqualsToken : ts.SyntaxKind.ExclamationEqualsEqualsToken;
    literal = null;
  }
  const path = [...pathParts];
  let actualPath = path;
  const parentType = typeAtPath(path, parameterMap, localMockMap, checker, location);
  if (path[path.length - 1] === 'length' && typeof literal === 'number') {
    actualPath = path.slice(0, -1);
    const collectionType = typeAtPath(actualPath, parameterMap, localMockMap, checker, location);
    let min = 0;
    let max = 8;
    const excluded = [];
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      if (!Number.isInteger(literal) || literal < 0 || literal > 8) {
        return [{ assignments: new Map(), unsupported: [`Length ${literal} is outside the supported 0..8 range at ${path.join('.')}`] }];
      }
      min = literal;
      max = literal;
    } else if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      if (Number.isInteger(literal) && literal >= 0 && literal <= 8) excluded.push(literal);
    } else if (op === ts.SyntaxKind.GreaterThanToken) min = Math.floor(literal) + 1;
    else if (op === ts.SyntaxKind.GreaterThanEqualsToken) min = Math.ceil(literal);
    else if (op === ts.SyntaxKind.LessThanToken) max = Math.ceil(literal) - 1;
    else if (op === ts.SyntaxKind.LessThanEqualsToken) max = Math.floor(literal);
    else return [{ assignments: new Map(), unsupported: [`Unsupported length operator at ${path.join('.')}`] }];
    min = Math.max(0, min);
    max = Math.min(8, max);
    const inferredCollection = inferredInfoForPath(actualPath, inferredPaths);
    const isArray = Boolean((collectionType && (checker.isArrayType(collectionType) || checker.isTupleType(collectionType))) || (inferredCollection?.kind === 'array' || inferredCollection?.kind === 'sequence'));
    const elementType = collectionType && isArray ? checker.getTypeArguments(collectionType)?.[0] : null;
    const inferredItem = isArray ? buildInferredValue([...actualPath, '0'], inferredPaths) : undefined;
    const itemValue = elementType ? defaultValueForType(elementType, checker, location) : inferredItem ?? null;
    if (min > max) return [{ assignments: new Map(), unsupported: [`No length in supported range satisfies ${path.join('.')}`] }];
    return [makeLengthAssignment(actualPath, min, max, excluded, Boolean(isArray), itemValue)];
  }

  if (typeof literal === 'number' && [
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ].includes(op)) {
    const allowedValues = numericAllowedValues(parentType);
    const constraint = {
      min: null,
      minInclusive: true,
      max: null,
      maxInclusive: true,
      excluded: [],
      allowedValues,
    };
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      constraint.min = literal;
      constraint.max = literal;
    } else if (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
      constraint.excluded.push(literal);
    } else if (op === ts.SyntaxKind.LessThanToken) {
      constraint.max = literal;
      constraint.maxInclusive = false;
    } else if (op === ts.SyntaxKind.LessThanEqualsToken) constraint.max = literal;
    else if (op === ts.SyntaxKind.GreaterThanToken) {
      constraint.min = literal;
      constraint.minInclusive = false;
    } else if (op === ts.SyntaxKind.GreaterThanEqualsToken) constraint.min = literal;
    if (allowedValues && !allowedValues.some(value => satisfiesNumericConstraint(value, constraint))) {
      return [{ assignments: new Map(), unsupported: [`No value in ${checker.typeToString(parentType)} satisfies the comparison at ${path.join('.')}`] }];
    }
    if (!allowedValues && materializeNumericConstraint(constraint) === undefined) {
      return [{ assignments: new Map(), unsupported: [`No numeric value satisfies the comparison at ${path.join('.')}`] }];
    }
    return [makeNumericAssignment(actualPath, constraint)];
  }

  let values;
  if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(op)) values = [literal];
  else if ([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(op)) values = differentLiteralCandidates(literal, parentType);
  else return [{ assignments: new Map(), unsupported: [`Cannot solve comparison: ${path.join('.')} ${ts.tokenToString(operator) ?? 'operator'} ${String(literal)}`] }];

  return values.map(value => {
    if (!isDefinitelyAssignable(value, parentType)) {
      return {
        assignments: new Map(),
        unsupported: [`Value ${String(value)} is not compatible with ${checker.typeToString(parentType)} at ${path.join('.')}; branch may be unreachable.`],
      };
    }
    return makeAssignment(actualPath, value);
  });
}

function typeBasedTruthy(pathParts, truthy, parameterMap, localMockMap, checker, location, inferredPaths) {
  const rawType = typeAtPath(pathParts, parameterMap, localMockMap, checker, location);
  const type = nonNullishType(rawType);
  const inferred = inferredInfoForPath(pathParts, inferredPaths);
  const typeIsUnknown = !rawType || hasTypeFlagInUnion(rawType, ts.TypeFlags.Any | ts.TypeFlags.Unknown);
  const inferredKind = typeIsUnknown ? inferred?.kind : null;
  let value;
  let unsupported = [];

  if (!truthy) {
    if (type && hasTypeFlagInUnion(type, ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) value = false;
    else if (type && hasTypeFlagInUnion(type, ts.TypeFlags.NumberLike)) value = 0;
    else if (type && hasTypeFlagInUnion(type, ts.TypeFlags.StringLike)) value = '';
    else if (rawType && unionMembers(rawType).some(member => typeHasFlag(member, ts.TypeFlags.Undefined))) value = UNDEFINED;
    else if (rawType && unionMembers(rawType).some(member => typeHasFlag(member, ts.TypeFlags.Null))) value = null;
    else if (typeIsUnknown && inferredKind === 'boolean') value = false;
    else if (typeIsUnknown && inferredKind === 'number') value = 0;
    else if (typeIsUnknown && inferredKind === 'string') value = '';
    else if (typeIsUnknown && (inferredKind === 'array' || inferredKind === 'sequence' || inferredKind === 'object')) value = null;
    else if (typeIsUnknown) value = null;
    else {
      value = null;
      unsupported = [`Falsy object outcome may be unreachable for non-nullable type ${checker.typeToString(rawType)} at ${pathParts.join('.')}`];
    }
  } else if (type && hasTypeFlagInUnion(type, ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) value = true;
  else if (type && hasTypeFlagInUnion(type, ts.TypeFlags.NumberLike)) value = 1;
  else if (type && hasTypeFlagInUnion(type, ts.TypeFlags.StringLike)) value = 'test';
  else if (typeIsUnknown && inferredKind === 'boolean') value = true;
  else if (typeIsUnknown && inferredKind === 'number') value = 1;
  else if (typeIsUnknown && inferredKind === 'string') value = 'test';
  else if (typeIsUnknown && (inferredKind === 'array' || inferredKind === 'sequence')) value = buildInferredValue(pathParts, inferredPaths);
  else if (typeIsUnknown && (inferredKind === 'object' || (pathParts.length === 1 && buildInferredValue(pathParts, inferredPaths) && Object.keys(buildInferredValue(pathParts, inferredPaths)).length))) {
    value = buildInferredValue(pathParts, inferredPaths);
  } else if (typeIsUnknown && pathParts.length === 1) {
    value = inferredDefaultForPath(pathParts, inferredPaths) ?? {};
  } else value = defaultValueForType(type, checker, location) ?? {};

  const result = makeAssignment(pathParts, value);
  result.unsupported = unsupported;
  return result;
}

function mergeSolutions(a, b) {
  const assignments = new Map(a.assignments);
  for (const [key, item] of b.assignments) {
    if (assignments.has(key)) {
      const existingItem = assignments.get(key);
      if (existingItem.lengthConstraint && item.lengthConstraint) {
        const mergedConstraint = mergeLengthConstraints(existingItem.lengthConstraint, item.lengthConstraint);
        if (!mergedConstraint) return null;
        assignments.set(key, { path: item.path, lengthConstraint: mergedConstraint });
        continue;
      }
      if (existingItem.numericConstraint && item.numericConstraint) {
        const mergedConstraint = mergeNumericConstraints(existingItem.numericConstraint, item.numericConstraint);
        if (!mergedConstraint) return null;
        assignments.set(key, { path: item.path, numericConstraint: mergedConstraint });
        continue;
      }
      if (existingItem.lengthConstraint || item.lengthConstraint || existingItem.numericConstraint || item.numericConstraint) return null;
      if (!sameValue(existingItem.value, item.value)) return null;
    }
    assignments.set(key, item);
  }
  return { assignments, unsupported: [...a.unsupported, ...b.unsupported] };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === UNDEFINED || b === UNDEFINED) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function combineSolutions(left, right, maxAlternatives = DEFAULT_MAX_ALTERNATIVES) {
  const output = [];
  for (const a of left) {
    for (const b of right) {
      const merged = mergeSolutions(a, b);
      if (merged) output.push(merged);
      if (output.length >= maxAlternatives) return output;
    }
  }
  return output;
}

function unsupportedSolution(message) {
  return [{ assignments: new Map(), unsupported: [message] }];
}

function evaluateStaticCondition(node) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    const value = evaluateStaticCondition(current.operand);
    return value === null ? null : !value;
  }
  if (!ts.isBinaryExpression(current)) return null;
  const operator = current.operatorToken.kind;
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
    const left = evaluateStaticCondition(current.left);
    const right = evaluateStaticCondition(current.right);
    if (left === null || right === null) return null;
    return operator === ts.SyntaxKind.AmpersandAmpersandToken ? left && right : left || right;
  }
  const left = getLiteral(current.left);
  const right = getLiteral(current.right);
  if (!left.ok || !right.ok) return null;
  const a = left.value === UNDEFINED ? undefined : left.value;
  const b = right.value === UNDEFINED ? undefined : right.value;
  switch (operator) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return a === b;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return a !== b;
    case ts.SyntaxKind.EqualsEqualsToken: return a == b; // Intentional JS loose-equality semantics.
    case ts.SyntaxKind.ExclamationEqualsToken: return a != b; // Intentional JS loose-inequality semantics.
    case ts.SyntaxKind.LessThanToken: return a < b;
    case ts.SyntaxKind.LessThanEqualsToken: return a <= b;
    case ts.SyntaxKind.GreaterThanToken: return a > b;
    case ts.SyntaxKind.GreaterThanEqualsToken: return a >= b;
    default: return null;
  }
}

function withArrayCallbackAliases(descriptor, itemIndex, context, callbackIndex = itemIndex, accumulatorAlias = null) {
  const previousAliases = new Map(context.pathAliases);
  if (descriptor.isReduce) {
    const [accumulatorParameter, itemParameter, indexParameter] = descriptor.callback.parameters;
    const itemPath = [...descriptor.collectionPath, String(descriptor.hasInitialValue ? itemIndex : Math.max(1, itemIndex))];
    if (itemParameter && ts.isIdentifier(itemParameter.name)) context.pathAliases.set(itemParameter.name.text, { kind: 'path', path: itemPath });
    if (indexParameter && ts.isIdentifier(indexParameter.name)) context.pathAliases.set(indexParameter.name.text, { kind: 'constant', value: itemIndex });
    if (accumulatorParameter && ts.isIdentifier(accumulatorParameter.name) && accumulatorAlias) {
      context.pathAliases.set(accumulatorParameter.name.text, accumulatorAlias);
    }
  } else {
    const pipelineContext = getArrayPipelineContext(descriptor, itemIndex, context, callbackIndex);
    context.pathAliases.clear();
    for (const [name, alias] of pipelineContext.aliases) context.pathAliases.set(name, alias);
  }
  return () => {
    context.pathAliases.clear();
    for (const [name, alias] of previousAliases) context.pathAliases.set(name, alias);
  };
}

function evaluateBinaryValues(left, operator, right) {
  switch (operator) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
    case ts.SyntaxKind.EqualsEqualsToken: return left == right; // Intentional JS loose equality.
    case ts.SyntaxKind.ExclamationEqualsToken: return left != right; // Intentional JS loose inequality.
    case ts.SyntaxKind.LessThanToken: return left < right;
    case ts.SyntaxKind.LessThanEqualsToken: return left <= right;
    case ts.SyntaxKind.GreaterThanToken: return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken: return left >= right;
    default: return null;
  }
}

function getPipelineRepresentativeLength(descriptor, requestedLength = 1) {
  const needsPair = (descriptor?.pipeline ?? []).some(stage =>
    ARRAY_COMPARATOR_METHODS.has(stage.method) || ['reverse', 'toReversed'].includes(stage.method));
  return Math.max(requestedLength, needsPair ? 2 : 1);
}

function solveFindIndexComparison(binary, desired, context) {
  const left = unwrap(binary.left);
  const right = unwrap(binary.right);
  const leftDescriptor = ts.isCallExpression(left) ? getArrayCallbackDescriptor(left, context) : null;
  const rightDescriptor = ts.isCallExpression(right) ? getArrayCallbackDescriptor(right, context) : null;
  const descriptor = ['findIndex', 'findLastIndex'].includes(leftDescriptor?.method) ? leftDescriptor
    : ['findIndex', 'findLastIndex'].includes(rightDescriptor?.method) ? rightDescriptor : null;
  if (!descriptor) return null;
  const literalNode = descriptor === leftDescriptor ? right : left;
  const literal = getLiteral(literalNode);
  if (!literal.ok) return unsupportedSolution('findIndex() comparison currently requires a literal on the other side.');

  const candidates = [-1, 0, 1].filter(candidate => {
    const result = descriptor === leftDescriptor
      ? evaluateBinaryValues(candidate, binary.operatorToken.kind, literal.value === UNDEFINED ? undefined : literal.value)
      : evaluateBinaryValues(literal.value === UNDEFINED ? undefined : literal.value, binary.operatorToken.kind, candidate);
    return result === desired;
  });
  const itemValue = getLoopElementValue(descriptor.collectionPath, context, binary, '0');
  const predicate = getCallbackPredicateExpression(descriptor.callback);
  if (!predicate) return unsupportedSolution('Cannot extract a simple findIndex() predicate.');

  const outcomes = [];
  for (const foundIndex of candidates) {
    if (foundIndex < 0) {
      outcomes.push(makeAssignment(descriptor.collectionPath, []));
      continue;
    }
    const array = Array.from({ length: getPipelineRepresentativeLength(descriptor, foundIndex + 1) }, () => cloneJson(itemValue));
    const base = [makeAssignment(descriptor.collectionPath, array)];
    let predicateSolutions = [];
    if (foundIndex === 1 && descriptor.method === 'findIndex') {
      const restoreFirst = withArrayCallbackAliases(descriptor, 0, context, 0);
      let firstFalse;
      try {
        firstFalse = combineSolutions(getArrayPipelineContext(descriptor, 0, context, 0).filterSolutions,
          solveCondition(predicate, false, context), context.maxAlternatives);
      } finally { restoreFirst(); }
      const restoreSecond = withArrayCallbackAliases(descriptor, 1, context, 1);
      let secondTrue;
      try {
        secondTrue = combineSolutions(getArrayPipelineContext(descriptor, 1, context, 1).filterSolutions,
          solveCondition(predicate, true, context), context.maxAlternatives);
      } finally { restoreSecond(); }
      predicateSolutions = combineSolutions(firstFalse, secondTrue, context.maxAlternatives);
    } else {
      const restore = withArrayCallbackAliases(descriptor, foundIndex, context, foundIndex);
      try {
        predicateSolutions = combineSolutions(getArrayPipelineContext(descriptor, foundIndex, context, foundIndex).filterSolutions,
          solveCondition(predicate, true, context), context.maxAlternatives);
      } finally { restore(); }
    }
    outcomes.push(...combineSolutions(base, predicateSolutions, context.maxAlternatives));
  }
  return outcomes;
}

function solveFindComparison(binary, desired, context) {
  const left = unwrap(binary.left);
  const right = unwrap(binary.right);
  const leftDescriptor = ts.isCallExpression(left) ? getArrayCallbackDescriptor(left, context) : null;
  const rightDescriptor = ts.isCallExpression(right) ? getArrayCallbackDescriptor(right, context) : null;
  const descriptor = ['find', 'findLast'].includes(leftDescriptor?.method) ? leftDescriptor
    : ['find', 'findLast'].includes(rightDescriptor?.method) ? rightDescriptor : null;
  if (!descriptor) return null;
  const literalNode = descriptor === leftDescriptor ? right : left;
  const literal = getLiteral(literalNode);
  if (!literal.ok || ![UNDEFINED, null].includes(literal.value)) {
    return unsupportedSolution('find() comparison currently supports only undefined or null literals.');
  }
  const notFound = undefined;
  const found = {};
  const candidates = [notFound, found].filter(candidate => {
    const actual = descriptor === leftDescriptor
      ? evaluateBinaryValues(candidate, binary.operatorToken.kind, literal.value === UNDEFINED ? undefined : literal.value)
      : evaluateBinaryValues(literal.value === UNDEFINED ? undefined : literal.value, binary.operatorToken.kind, candidate);
    return actual === desired;
  });
  const output = [];
  for (const candidate of candidates) {
    if (candidate === notFound) {
      output.push(makeAssignment(descriptor.collectionPath, []));
      continue;
    }
    const predicate = getCallbackPredicateExpression(descriptor.callback);
    if (!predicate) return unsupportedSolution(`Cannot extract a simple ${descriptor.method}() predicate.`);
    const usesIndex = descriptor.callback.parameters?.[1] && ts.isIdentifier(descriptor.callback.parameters[1].name) &&
      callbackUsesIdentifier(descriptor.callback, descriptor.callback.parameters[1].name.text);
    const needsLastRepresentative = descriptor.method === 'findLast' && descriptor.pipeline.length > 0;
    const foundIndexes = needsLastRepresentative ? [1] : usesIndex ? [0, 1] : [0];
    for (const foundIndex of foundIndexes) {
      const array = Array.from({ length: getPipelineRepresentativeLength(descriptor, foundIndex + 1) }, () => getLoopElementValue(descriptor.collectionPath, context, binary, '0'));
      const restore = withArrayCallbackAliases(descriptor, foundIndex, context, foundIndex);
      let solved;
      try {
        solved = combineSolutions(getArrayPipelineContext(descriptor, foundIndex, context, foundIndex).filterSolutions,
          solveCondition(predicate, true, context), context.maxAlternatives);
      } finally { restore(); }
      output.push(...combineSolutions([makeAssignment(descriptor.collectionPath, array)], solved, context.maxAlternatives));
    }
  }
  return output;
}

function extractAffineForm(node, aliases = new Map()) {
  const current = unwrap(node);
  if (!current) return null;
  const literal = getLiteral(current);
  if (literal.ok && typeof literal.value === 'number') return { constant: literal.value };
  const path = getPathWithAliases(current, aliases);
  if (path && path[path.length - 1] !== 'length') return { path, coefficient: 1, offset: 0 };
  if (ts.isPrefixUnaryExpression(current) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(current.operator)) {
    const inner = extractAffineForm(current.operand, aliases);
    if (!inner) return null;
    const sign = current.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    return inner.path ? { ...inner, coefficient: inner.coefficient * sign, offset: inner.offset * sign } : { constant: inner.constant * sign };
  }
  if (!ts.isBinaryExpression(current)) return null;
  const operator = current.operatorToken.kind;
  const left = extractAffineForm(current.left, aliases);
  const right = extractAffineForm(current.right, aliases);
  if (!left || !right) return null;
  const leftHasPath = Boolean(left.path);
  const rightHasPath = Boolean(right.path);
  if (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken) {
    if (leftHasPath && rightHasPath && left.path.join('.') !== right.path.join('.')) return null;
    const sign = operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    if (!leftHasPath && !rightHasPath) return { constant: left.constant + sign * right.constant };
    const source = leftHasPath ? left : right;
    const other = leftHasPath ? right : left;
    if (leftHasPath && rightHasPath) {
      return { path: left.path, coefficient: left.coefficient + sign * right.coefficient, offset: left.offset + sign * right.offset };
    }
    return leftHasPath
      ? { path: source.path, coefficient: source.coefficient, offset: source.offset + sign * other.constant }
      : { path: source.path, coefficient: sign * source.coefficient, offset: sign * source.offset + left.constant };
  }
  if (operator === ts.SyntaxKind.AsteriskToken) {
    if (leftHasPath && rightHasPath) return null;
    if (!leftHasPath && !rightHasPath) return { constant: left.constant * right.constant };
    const source = leftHasPath ? left : right;
    const factor = leftHasPath ? right.constant : left.constant;
    return { path: source.path, coefficient: source.coefficient * factor, offset: source.offset * factor };
  }
  if (operator === ts.SyntaxKind.SlashToken && leftHasPath && !rightHasPath && right.constant !== 0) {
    return { path: left.path, coefficient: left.coefficient / right.constant, offset: left.offset / right.constant };
  }
  return null;
}

function solveAffineComparison(binary, desired, context) {
  // Preserve the long-standing boundary-aware solver for simple path/literal
  // and path/path comparisons. Affine search is only needed when projection
  // expansion has left an arithmetic expression in the condition.
  const simpleLeftPath = getPathWithAliases(binary.left, context.pathAliases);
  const simpleRightPath = getPathWithAliases(binary.right, context.pathAliases);
  const simpleLeftLiteral = getLiteral(binary.left);
  const simpleRightLiteral = getLiteral(binary.right);
  if ((simpleLeftPath && simpleRightLiteral.ok) || (simpleRightPath && simpleLeftLiteral.ok) || (simpleLeftPath && simpleRightPath)) return null;
  const left = extractAffineForm(binary.left, context.pathAliases);
  const right = extractAffineForm(binary.right, context.pathAliases);
  if (!left || !right || (!left.path && !right.path)) return null;
  const operator = binary.operatorToken.kind;
  if (![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(operator)) return null;

  const candidates = [-10, -1, 0, 1, 2, 5, 10, 11, 20, 21, 50, 100];
  const leftPathKey = left.path?.join('.') ?? null;
  const rightPathKey = right.path?.join('.') ?? null;
  const samePath = leftPathKey && rightPathKey && leftPathKey === rightPathKey;
  const results = [];
  const seen = new Set();
  for (const x of (left.path || samePath ? candidates : [null])) {
    for (const y of (right.path && !samePath ? candidates : [null])) {
      const leftInput = left.path ? x : left.constant;
      const rightInput = right.path ? (samePath ? x : y) : right.constant;
      const leftValue = left.path ? left.coefficient * leftInput + left.offset : leftInput;
      const rightValue = right.path ? right.coefficient * rightInput + right.offset : rightInput;
      if (evaluateBinaryValues(leftValue, operator, rightValue) !== desired) continue;
      const assignments = [];
      if (left.path) assignments.push(makeAssignment(left.path, leftInput));
      if (right.path && !samePath) assignments.push(makeAssignment(right.path, rightInput));
      let combined = [{ assignments: new Map(), unsupported: [] }];
      for (const assignment of assignments) combined = combineSolutions(combined, [assignment], context.maxAlternatives);
      for (const solution of combined) {
        const fingerprint = JSON.stringify([...solution.assignments].map(([key, value]) => [key, value.value]));
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        results.push(solution);
        if (results.length >= context.maxAlternatives) return results;
      }
    }
  }
  return results;
}

function constraintTypeAtPath(pathParts, operationContext, location) {
  const { parameterMap, localMockMap } = operationContext.paths;
  const checker = operationContext.function.checker;
  let type = parameterMap.get(pathParts[0])?.type ?? localMockMap.get(pathParts[0])?.resolvedType ?? null;
  let optional = false;
  if (!type) return { type: null, optional };

  for (const part of pathParts.slice(1)) {
    const current = nonNullishType(type);
    if (!current) return { type: null, optional };
    if (/^\d+$/.test(part) && (checker.isArrayType(current) || checker.isTupleType(current))) {
      const index = Number(part);
      const elementTypes = checker.getTypeArguments(current) ?? [];
      type = checker.isTupleType(current)
        ? (elementTypes[index] ?? checker.getIndexTypeOfType(current, ts.IndexKind.Number))
        : (elementTypes[0] ?? checker.getIndexTypeOfType(current, ts.IndexKind.Number));
      if (!type) return { type: null, optional };
      continue;
    }
    const property = checker.getPropertiesOfType(current).find(item => item.getName() === part);
    if (!property) return { type: null, optional };
    optional ||= Boolean(property.flags & ts.SymbolFlags.Optional);
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    type = checker.getTypeOfSymbolAtLocation(property, declaration ?? location);
  }
  return { type, optional };
}

function constraintPathHint(pathParts, operationContext, location) {
  const resolved = constraintTypeAtPath(pathParts, operationContext, location);
  const checker = operationContext.function.checker;
  const rawType = resolved.type;
  const modelProperty = operationContext.paths.dataFlowModel?.properties?.find(property =>
    property.path?.rootName === pathParts[0] &&
    JSON.stringify(property.path?.segments ?? []) === JSON.stringify(pathParts.slice(1)));
  let kind = classifyKnownType(rawType, checker);
  if (!kind && modelProperty?.kind && modelProperty.kind !== 'unknown' && modelProperty.kind !== 'date' && modelProperty.kind !== 'enum') kind = modelProperty.kind;
  if (!kind) {
    const inferred = inferredInfoForPath(pathParts, operationContext.paths.inferredPaths);
    kind = inferred?.kind === 'sequence' ? 'array' : inferred?.kind ?? 'unknown';
  }
  const nonNullishMembers = unionMembers(rawType).filter(member =>
    !typeHasFlag(member, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  const literalValues = nonNullishMembers.map(literalForType);
  const allowedValues = nonNullishMembers.length > 0 &&
    literalValues.every(value => value !== undefined && ['string', 'number', 'boolean'].includes(typeof value))
    ? [...new Set(literalValues)] : undefined;
  return {
    type: rawType,
    hint: {
      kind: ['string', 'number', 'boolean', 'array', 'object'].includes(kind) ? kind : 'unknown',
      ...(resolved.optional || modelProperty?.optional || (rawType && hasTypeFlagInUnion(rawType, ts.TypeFlags.Undefined | ts.TypeFlags.Void)) ? { optional: true } : {}),
      ...(modelProperty?.nullable || (rawType && hasTypeFlagInUnion(rawType, ts.TypeFlags.Null)) ? { nullable: true } : {}),
      ...(modelProperty?.enumValues?.length ? { allowedValues: modelProperty.enumValues.map(value => value?.$undefined ? undefined : value) } : {}),
      ...(allowedValues ? { allowedValues } : {}),
    },
  };
}

function setConstraintSeedPath(target, pathParts, value) {
  if (!pathParts.length) return;
  if (pathParts.length === 1) {
    Object.defineProperty(target, pathParts[0], {
      value: value === UNDEFINED ? { $undefined: true } : cloneJson(value),
      enumerable: true, writable: true, configurable: true,
    });
    return;
  }
  setNestedValue(target, pathParts, value);
}

function constraintPathRefsForAtoms(atoms) {
  const refs = [];
  for (const item of atoms ?? []) refs.push(...collectConstraintPaths(item));
  const unique = new Map();
  for (const ref of refs) unique.set(JSON.stringify([ref.path, ref.accessor]), ref);
  return [...unique.values()];
}

function buildConstraintSeed(solution, atoms, operationContext, location) {
  const seed = {};
  for (const assignment of solution.assignments.values()) {
    const value = assignment.lengthConstraint
      ? materializeLengthConstraint(assignment.lengthConstraint)
      : assignment.numericConstraint
        ? materializeNumericConstraint(assignment.numericConstraint)
        : assignment.value;
    if (value === null && (assignment.lengthConstraint || assignment.numericConstraint)) continue;
    setConstraintSeedPath(seed, assignment.path, value);
  }

  const paths = new Map();
  for (const ref of constraintPathRefsForAtoms(atoms)) paths.set(JSON.stringify(ref.path), ref.path);
  for (const path of paths.values()) {
    let cursor = seed;
    let exists = true;
    for (const part of path) {
      if (cursor === null || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, part)) {
        exists = false;
        break;
      }
      cursor = cursor[part];
    }
    if (exists) continue;

    const { type, hint } = constraintPathHint(path, operationContext, location);
    let value;
    // Seed structural values only. Primitive defaults bias the new solver
    // away from boundary representatives and would change frozen compatibility fixtures
    // (e.g. age < 18 should retain the established representative 17).
    if (hint.kind === 'object' || hint.kind === 'array') {
      if (type && !typeHasFlag(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
        value = defaultValueForType(type, operationContext.function.checker, location);
      } else {
        value = inferredDefaultForPath(path, operationContext.paths.inferredPaths);
      }
      if (value !== undefined && value !== null) setConstraintSeedPath(seed, path, value);
    }
  }
  return seed;
}

function pathsOverlap(left, right) {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hasAnyIncomingPathOverlap(solution, atoms) {
  for (const assignment of solution.assignments.values()) {
    for (const item of atoms) {
      if (pathsOverlap(assignment.path, item.path) ||
          (item.valuePath && pathsOverlap(assignment.path, item.valuePath))) return true;
    }
  }
  return false;
}

function hasIncomingPathOverlap(solution, atoms) {
  for (const assignment of solution.assignments.values()) {
    if (!assignment.lengthConstraint && !assignment.numericConstraint) continue;
    for (const item of atoms) {
      if (pathsOverlap(assignment.path, item.path) ||
          (item.valuePath && pathsOverlap(assignment.path, item.valuePath))) return true;
    }
  }
  return false;
}

const mcdcPairFeasibilityVerifier = createMcdcPairFeasibilityVerifier({
  readPath: readConstraintPath,
  isStrictPathPrefix,
  sameValue,
  undefinedValue: UNDEFINED,
});
const preservesMcdcIncomingAssignments = (...args) => mcdcPairFeasibilityVerifier.preservesIncomingAssignments(...args);

function isStrictPathPrefix(prefix, pathParts) {
  return prefix.length < pathParts.length && prefix.every((part, index) => part === pathParts[index]);
}

function deleteConstraintPath(root, pathParts) {
  if (!pathParts.length) return;
  let cursor = root;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, pathParts[index])) return;
    cursor = cursor[pathParts[index]];
  }
  if (cursor && typeof cursor === 'object') delete cursor[pathParts[pathParts.length - 1]];
}

function readConstraintPath(root, pathParts) {
  let value = root;
  for (const part of pathParts) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) {
      return { exists: false, value: UNDEFINED };
    }
    value = value[part];
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).length === 1 && value.$undefined === true) {
      return { exists: true, value: UNDEFINED };
    }
  }
  return { exists: true, value };
}

function recordConstraintFallback(context, reason) {
  const key = String(reason || 'IR solver did not produce a usable assignment');
  dispatchAnalysisEvent(context, { type: 'analysis.constraint-fallback-recorded', reason: key });
}

/**
 * IR-first bridge used by the control-flow walker. The multi-result solver
 * preserves every bounded short-circuit witness for supported expressions.
 * The recursive AST fallback remains the conservative path whenever compilation, type
 * materialization, incoming-path preservation, or the configured search
 * budget cannot be proven complete.
 */
let constraintAnalysisService;

/** Compatibility entrypoint: the service owns IR-first solving and fallback delegation. */
function solveCondition(node, desired, context, incomingSolutions = null) {
  if (!constraintAnalysisService) throw new Error('ConstraintAnalysisService has not been initialized.');
  return constraintAnalysisService.solveCondition(node, desired, createFunctionAnalysisOperationContext(context), incomingSolutions);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneJson(v)]));
  return value;
}

function applyAssignment(args, assignment, parameterMap, localMockMap, checker, location, mockValues) {
  const parts = assignment.path;
  const value = assignment.lengthConstraint
    ? materializeLengthConstraint(assignment.lengthConstraint)
    : assignment.numericConstraint
      ? materializeNumericConstraint(assignment.numericConstraint)
      : assignment.value;
  const parameter = parameterMap.get(parts[0]);
  if (parameter) {
    if (parts.length === 1) {
      args[parameter.index] = value === UNDEFINED ? { $undefined: true } : cloneJson(value);
      return;
    }
    if (args[parameter.index] === null || args[parameter.index] === undefined || (args[parameter.index] && args[parameter.index].$undefined)) {
      args[parameter.index] = defaultValueForType(parameter.type, checker, location) ?? {};
    }
    setNestedValue(args[parameter.index], parts.slice(1), value);
    return;
  }

  const localBinding = localMockMap.get(parts[0]);
  if (localBinding) {
    const key = localBinding.call;
    if (!mockValues.has(key)) {
      mockValues.set(key, {
        call: key,
        behavior: localBinding.isPromise ? 'mockResolvedValue' : 'mockReturnValue',
        resolvedValue: defaultValueForType(localBinding.resolvedType, checker, location),
      });
    }
    const mock = mockValues.get(key);
    if (parts.length === 1) {
      mock.resolvedValue = value === UNDEFINED ? { $undefined: true } : cloneJson(value);
    } else {
      if (mock.resolvedValue === null || mock.resolvedValue === undefined || (mock.resolvedValue && mock.resolvedValue.$undefined)) {
        mock.resolvedValue = defaultValueForType(localBinding.resolvedType, checker, location) ?? {};
      }
      setNestedValue(mock.resolvedValue, parts.slice(1), value);
    }
  }
}

function setNestedValue(target, pathParts, value) {
  if (!target || typeof target !== 'object') return;
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const part = pathParts[index];
    const nextPart = pathParts[index + 1];
    const shouldBeArray = /^\d+$/.test(nextPart);
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = shouldBeArray ? [] : {};
    cursor = cursor[part];
  }
  const last = pathParts[pathParts.length - 1];
  if (value === UNDEFINED) delete cursor[last];
  else cursor[last] = cloneJson(value);
}

function serializable(value) {
  return undefinedValueSerializer.serialize(value);
}

function getBranchId(kind, node, sourceFile) {
  const pos = formatLine(sourceFile, node);
  return `${kind}-${pos.line}-${pos.column}`;
}

function getMcdcDecisionId(kind, node, sourceFile) {
  return getBranchId(`mcdc-${kind}`, node, sourceFile);
}

function dispatchAnalysisEvent(ctx, event) {
  ctx.analysisState?.dispatch(event);
}

function recordBranchOutcome(ctx, branchId, outcome, key = `${branchId}:${String(outcome)}`) {
  dispatchAnalysisEvent(ctx, { type: 'analysis.branch-outcome-observed', key, branchId, outcome });
}

function recordUnsupportedBranch(ctx, branch) {
  dispatchAnalysisEvent(ctx, { type: 'analysis.unsupported-branch-recorded', branch });
}

function clearUnsupportedBranch(ctx, branchId, outcome) {
  dispatchAnalysisEvent(ctx, { type: 'analysis.unsupported-branch-cleared', branchId, outcome });
}

function recordScenario(ctx, scenario, { loop = false } = {}) {
  dispatchAnalysisEvent(ctx, {
    type: loop ? 'analysis.loop-scenario-added' : 'analysis.scenario-added',
    scenario,
  });
}

function recordLoopEntered(ctx) {
  dispatchAnalysisEvent(ctx, { type: 'analysis.loop-entered' });
}

function incrementConstraintStat(context, key, amount = 1) {
  dispatchAnalysisEvent(context, { type: 'analysis.constraint-stat-incremented', key, amount });
}

function createFunctionAnalysisOperationContext(context) {
  return createAnalysisOperationContext(context, {
    dispatch: dispatchAnalysisEvent,
    incrementConstraintStat,
    recordConstraintFallback,
    maxMcdcAtoms: MAX_MCDC_ATOMS,
    maxMcdcCombinations: MAX_MCDC_COMBINATIONS,
  });
}

let arrayPipelineRuntime;
function requireArrayPipelineRuntime() {
  if (!arrayPipelineRuntime) throw new Error('ArrayPipelineRuntime has not been initialized.');
  return arrayPipelineRuntime;
}
function getArrayReceiverModel(...args) { return requireArrayPipelineRuntime().getArrayReceiverModel(...args); }
function getArrayCallbackDescriptor(...args) { return requireArrayPipelineRuntime().getArrayCallbackDescriptor(...args); }
function getArrayPipelineContext(...args) { return requireArrayPipelineRuntime().getArrayPipelineContext(...args); }
function getCallbackSingleReturnExpression(...args) { return requireArrayPipelineRuntime().getCallbackSingleReturnExpression(...args); }
function deriveMappedItemAlias(...args) { return requireArrayPipelineRuntime().deriveMappedItemAlias(...args); }
function aliasPathText(...args) { return requireArrayPipelineRuntime().aliasPathText(...args); }
function aliasMetadata(...args) { return requireArrayPipelineRuntime().aliasMetadata(...args); }
function bindCallbackParameters(...args) { return requireArrayPipelineRuntime().bindCallbackParameters(...args); }
function mapArrayAliasThroughStages(...args) { return requireArrayPipelineRuntime().mapArrayAliasThroughStages(...args); }
function inferComparatorOrder(...args) { return requireArrayPipelineRuntime().inferComparatorOrder(...args); }
function comparatorOrderSolutions(...args) { return requireArrayPipelineRuntime().comparatorOrderSolutions(...args); }

const propertyInference = createPropertyInference({
  ts,
  unwrap,
  getPathWithAliases,
  getPathAndLiteralWithAliases,
  getTwoPathsWithAliases,
  getLiteral,
  getLoopVariableName,
  getLoopInitialValue,
  findLengthCollectionPath,
  getArrayReceiverModel,
  isFunctionLikeCallback,
  getCallbackPredicateExpression,
  evaluateReduceExpression,
  deriveMappedItemAlias,
});
const { buildInferredValue, inferredDefaultForPath, inferredInfoForPath } = propertyInference;

const functionContextBuilder = createFunctionContextBuilder({
  ts,
  pathResolver,
  typeModelProvider,
  propertyInference,
  discoverMockContext,
  dataFlowAnalyzer: typeScriptDataFlowAnalyzer,
  createExpressionAliasResolver,
  ConstraintSolver,
  defaultMaxAlternatives: () => DEFAULT_MAX_ALTERNATIVES,
  getProjectRelativeFile: filename => path.relative(process.cwd(), filename).split(path.sep).join('/'),
});
const createFunctionContext = functionContextBuilder.createFunctionContext;

const scenarioGenerationService = createScenarioGenerationService({
  getBranchId, solveCondition, combineSolutions, recordUnsupportedBranch, recordBranchOutcome,
  clearUnsupportedBranch, recordScenario, assignmentMaterializer, defaultValueForType,
  mockPlanner, scenarioEvidenceBuilder, scenarioBuilder, scenarioReportAdapter, mockReportAdapter, formatLine, formatNodeSpan,
  cloneJson, applyAssignment, serializable,
});
const { addScenarios, addCustomSwitchScenario, addLoopScenario } = scenarioGenerationService;


function pathWithCondition(incoming, condition, desired, ctx) {
  return combineSolutions(incoming, solveCondition(condition, desired, ctx, incoming), ctx.maxAlternatives);
}

const mcdcDecisionExtractor = createMcdcDecisionExtractor({ ts, unwrap });
const mcdcNodeKey = mcdcDecisionExtractor.nodeKey;
const collectMcdcAtomicConditions = mcdcDecisionExtractor.collectAtomicConditions;
const evaluateMcdcExpression = mcdcDecisionExtractor.evaluateDecision;

let mcdcAnalysisOrchestrator;

function callbackUsesIndexParameter(descriptor) {
  if (!descriptor || descriptor.isReduce || ARRAY_COMPARATOR_METHODS.has(descriptor.method) || !descriptor.callback.parameters?.[1]) return false;
  const parameter = descriptor.callback.parameters[1];
  return ts.isIdentifier(parameter.name) && callbackUsesIdentifier(descriptor.callback, parameter.name.text);
}

function analyzeMcdcDecision(condition, incoming, ctx, kind, decisionNode = condition, runtimeExpressionNode = condition) {
  if (!mcdcAnalysisOrchestrator) throw new Error('McdcAnalysisOrchestrator has not been initialized.');
  return mcdcAnalysisOrchestrator.analyzeMcdcDecision(
    condition, incoming, createFunctionAnalysisOperationContext(ctx), kind, decisionNode, runtimeExpressionNode,
  );
}

const materializeMcdcScenario = createMcdcScenarioMaterializer({
  cloneValue: cloneJson,
  applyAssignment,
  serializeValue: serializable,
});

function buildMcdcScenario(solution, ctx, node, scenarioId, conditionValues, decisionOutcome) {
  return materializeMcdcScenario({ solution, context: ctx, node, scenarioId, conditionValues, decisionOutcome });
}


const expressionTraversal = createExpressionTraversal({
  ts,
  analyzeMcdcDecision,
  getMcdcDecisionId,
  addScenarios,
  pathWithCondition,
});
const analyzeTernaries = expressionTraversal.analyzeTernaries;


function getLoopCollectionPath(expression, ctx) {
  const pathParts = getPathWithAliases(expression, ctx.pathAliases);
  return pathParts && ctx.parameterMap.has(pathParts[0]) ? pathParts : null;
}

function getLoopElementValue(collectionPath, ctx, node, propertyName = '0') {
  const itemPath = [...collectionPath, propertyName];
  const itemType = typeAtPath(itemPath, ctx.parameterMap, ctx.localMockMap, ctx.checker, node);
  if (itemType && !typeHasFlag(itemType, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    const typedValue = defaultValueForType(itemType, ctx.checker, node);
    if (typedValue !== undefined && typedValue !== null) return typedValue;
  }
  const inferredItem = inferredDefaultForPath(itemPath, ctx.inferredPaths);
  return inferredItem !== undefined ? inferredItem : (buildInferredValue(itemPath, ctx.inferredPaths) ?? {});
}

function getLoopBodyStatements(statement) {
  return ts.isBlock(statement) ? statement.statements : [statement];
}

function createControlFlowAnalyzerPorts() {
  const maxAlternatives = context => context?.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES;
  return {
    ts,
    getPath,
    getLiteral,
    getBranchId,
    recordBranchOutcome,
    recordUnsupportedBranch,
    recordLoopEntered,
    makeAssignment,
    combineSolutions,
    unsupportedSolution,
    addCustomSwitchScenario,
    typeAtPath,
    unionMembers,
    literalForType,
    sameValue,
    chooseDifferent,
    addScenarios,
    pathWithCondition,
    analyzeMcdcDecision,
    analyzeTernaries,
    analyzeArrayCallbacksInNode,
    expandCallbackLocalVariables,
    coverageAnchorMetadata,
    getMcdcDecisionId,
    maxAlternatives,
    loopPorts: {
      ts,
      getLoopCollectionPath,
      getLoopElementValue,
      getLoopBodyStatements,
      getLoopVariableName,
      getLoopInitialValue,
      substituteIdentifiers,
      loopProgressesTowardExit,
      localCounterProgressesTowardExit,
      applyNumericUpdates,
      applyLoopIncrementor,
      loopIterationLimit: context => Math.min(16, Math.max(1, context?.maxLoopIterations ?? 8)),
      addLoopScenario,
      recordLoopEntered,
      recordUnsupportedBranch,
      combineSolutions,
      makeAssignment,
      pathWithCondition,
      addScenarios,
      analyzeMcdcDecision,
      coverageAnchorMetadata,
      getMcdcDecisionId,
      getBranchId,
      cloneJson,
    },
  };
}

// Array callback analysis resolves the active function's traversal from ctx;
// it never captures a process-wide ControlFlowAnalyzer instance.
function analyzeStatementList(statements, incoming, ctx) {
  if (!ctx.controlFlowAnalyzer) throw new Error('Function control-flow analyzer is not initialized.');
  return ctx.controlFlowAnalyzer.analyzeStatements(statements, incoming, ctx);
}


arrayPipelineRuntime = createArrayPipelineRuntime({
  ts, unwrap, getPathWithAliases, getLiteral, getPath, getNodeText,
  isFunctionLikeCallback, isSafeCallbackLocalInitializer,
  callbackMethods: ARRAY_CALLBACK_METHODS, reduceMethods: ARRAY_REDUCE_METHODS,
  comparatorMethods: ARRAY_COMPARATOR_METHODS,
  getCallbackPredicateSourceExpression, getCallbackPredicateExpression,
  serializable, substituteKnownAliases, extractAffineForm,
  solveCondition, unsupportedSolution, combineSolutions, makeAssignment,
});
// Infrastructure composition for constraint and MC/DC application services.
const recursiveAstFallbackAdapter = createRecursiveAstFallbackAdapter({
  deriveAnalysisOperationContext, ts, getArrayCallbackDescriptor, getCallbackPredicateExpression, getLoopElementValue,
  withArrayCallbackAliases, getArrayPipelineContext, combineSolutions, cloneJson,
  getPipelineRepresentativeLength, makeAssignment, callbackUsesIdentifier,
  solveFindIndexComparison, solveFindComparison, solveAffineComparison,
  getPathAndLiteralWithAliases, invertRelationalOperator, comparisonAssignment,
  getTwoPathsWithAliases, unsupportedSolution, getPathWithAliases, typeBasedTruthy,
});

constraintAnalysisService = createConstraintAnalysisService({
  ts, compileTypescriptCondition, collectConstraintPaths, createConstraintIR,
  constraintPathHint, buildConstraintSeed, isStrictPathPrefix, deleteConstraintPath,
  readConstraintPath, sameValue, makeAssignment, isDefinitelyAssignable,
  substituteKnownAliases, evaluateStaticCondition, unwrap, unsupportedSolution,
  recursiveAstFallbackAdapter,
});

mcdcAnalysisOrchestrator = createMcdcAnalysisOrchestrator({
  ts, compileTypescriptCondition,
  substituteKnownAliases, constraintPathHint,
  buildConstraintSeed, hasIncomingPathOverlap, hasAnyIncomingPathOverlap,
  preservesMcdcIncomingAssignments, readConstraintPath, isDefinitelyAssignable, makeAssignment,
  combineSolutions,
  solveCondition: (node, desired, operationContext, incoming) =>
    constraintAnalysisService.solveCondition(node, desired, operationContext, incoming),
  deriveAnalysisOperationContext, createConstraintIR, logical, negate,
  getBranchId, formatLine, getNodeText, planUniqueCauseCandidates,
  verifyUniqueCauseCandidate, evaluateMcdcExpression, collectMcdcAtomicConditions, mcdcNodeKey,
  buildMcdcScenario, callbackUsesIndexParameter, getLoopElementValue, cloneJson,
  getPipelineRepresentativeLength, getArrayPipelineContext,
});

function callbackUsesIdentifier(callback, identifier) {
  let used = false;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === identifier) used = true;
    if (!used) ts.forEachChild(node, visit);
  }
  visit(callback.body);
  return used;
}

function readPathValue(root, pathParts) {
  let value = root;
  for (const part of pathParts) value = value == null ? undefined : value[part];
  return value;
}

function getInputPathValue(pathParts, ctx) {
  const parameter = ctx.parameterMap.get(pathParts[0]);
  if (!parameter) return undefined;
  const root = ctx.baseArgs[parameter.index];
  return readPathValue(root, pathParts.slice(1));
}

let reduceStateInterpreterInstance;
function getReduceStateInterpreter() {
  if (!reduceStateInterpreterInstance) {
    reduceStateInterpreterInstance = createReduceStateInterpreter({
      ts,
      unwrap,
      getLiteral,
      undefinedMarker: UNDEFINED,
      getPathWithAliases,
      cloneJson,
      setNestedValue,
      getInputPathValue,
    });
  }
  return reduceStateInterpreterInstance;
}
function evaluateReduceExpression(node, environment) {
  return getReduceStateInterpreter().evaluateExpression(node, environment);
}
function evaluateReduceCallback(descriptor, accumulator, item, index, ctx) {
  return getReduceStateInterpreter().evaluateCallback(descriptor, accumulator, item, index, ctx);
}
function createReduceItemCandidates(collectionPath, baseItem, ctx) {
  return getReduceStateInterpreter().createItemCandidates(collectionPath, baseItem, ctx);
}
function getReduceIterationSpecs(descriptor, iterationIndex, itemValue, ctx) {
  return getReduceStateInterpreter().getIterationSpecs(descriptor, iterationIndex, itemValue, ctx);
}
function getReduceAccumulatorAlias(descriptor, ctx, collectionIndex) {
  return getReduceStateInterpreter().getAccumulatorAlias(descriptor, ctx, collectionIndex);
}

function registerArrayPipelineSummary(descriptor, ctx) {
  const call = descriptor.call;
  const id = `array-pipeline-${call.getStart(ctx.sourceFile)}-${call.getEnd()}`;
  if (ctx.arrayPipelineSeen.has(id)) return;
  ctx.arrayPipelineSeen.add(id);

  const method = descriptor.method;
  const hasReorderingStage = (descriptor.pipeline ?? []).some(stage =>
    ARRAY_COMPARATOR_METHODS.has(stage.method) || ['reverse', 'toReversed'].includes(stage.method));
  const callbackUsesIndex = callbackUsesIndexParameter(descriptor);
  const representativeIndex = ['findLast', 'findLastIndex'].includes(method) && hasReorderingStage
    ? 1
    : callbackUsesIndex ? 1 : 0;
  const context = getArrayPipelineContext(descriptor, representativeIndex, ctx, representativeIndex);
  const callbackExpression = getCallbackPredicateSourceExpression(descriptor.callback)
    ?? getCallbackSingleReturnExpression(descriptor.callback)
    ?? descriptor.callback.body;
  const inputAlias = context.itemAlias ?? { kind: 'path', path: [...descriptor.collectionPath, String(representativeIndex)] };
  const terminalStage = {
    index: descriptor.pipeline.length,
    method,
    role: 'callback-operation',
    input: aliasPathText(inputAlias),
    output: getArrayPipelineResultKind(method),
    callback: ts.isExpression(callbackExpression)
      ? getNodeText(callbackExpression, ctx.sourceFile)
      : callbackExpression.getText(ctx.sourceFile),
    callbackParameters: descriptor.callback.parameters.map(parameter =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(ctx.sourceFile)),
    representativeIndex,
    cardinality: method === 'filter' ? 'may-shrink'
      : ['some', 'every', 'find', 'findLast', 'findIndex', 'findLastIndex'].includes(method) ? 'short-circuit'
        : method === 'reduce' ? 'one-value' : 'method-defined',
  };
  const stages = [...context.trace, terminalStage].map(stage => ({ ...stage }));
  const warnings = [...new Set((context.filterSolutions ?? []).flatMap(solution => solution.unsupported ?? []))];

  const pipelineSummary = {
    id,
    sourceLocation: {
      line: call.getSourceFile().getLineAndCharacterOfPosition(call.getStart(ctx.sourceFile)).line + 1,
      column: call.getSourceFile().getLineAndCharacterOfPosition(call.getStart(ctx.sourceFile)).character + 1,
    },
    sourceExpression: call.getText(ctx.sourceFile),
    collection: descriptor.collectionPath.join('.'),
    representativeIndex,
    resultKind: getArrayPipelineResultKind(method),
    stages,
    elementAlias: aliasMetadata(context.itemAlias),
    requiredSourceIndexes: context.requiredSourceIndexes ?? [representativeIndex],
    assumptions: [...new Set(stages.map(stage => stage.mappingAssumption ?? stage.assumption).filter(Boolean))],
    warnings,
  };
  dispatchAnalysisEvent(ctx, { type: 'analysis.array-pipeline-recorded', pipeline: pipelineSummary });
}

let arrayCallbackAnalyzerInstance;
function getArrayCallbackAnalyzer() {
  if (!arrayCallbackAnalyzerInstance) {
    arrayCallbackAnalyzerInstance = createArrayCallbackAnalyzer({
      ts,
      getDescriptor: getArrayCallbackDescriptor,
      unwrap,
      getSourceText: (node, sourceFile) => node.getText(sourceFile),
      analyzeStatementList,
      analyzeTernaries,
      analyzeMcdcDecision,
      getMcdcDecisionId,
      addScenarios,
      registerPipelineSummary: registerArrayPipelineSummary,
      getLoopElementValue,
      cloneJson,
      makeAssignment,
      combineSolutions,
      getPipelineContext: getArrayPipelineContext,
      getCallbackPredicateExpression,
      getCallbackPredicateSourceExpression,
      getNodeText,
      solveCondition,
      callbackUsesIndexParameter,
      callbackUsesIdentifier,
      getReduceIterationSpecs,
      getPipelineRepresentativeLength,
      addLoopScenario,
      recordLoopEntered,
      maxAlternatives: context => context?.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES,
    });
  }
  return arrayCallbackAnalyzerInstance;
}
function analyzeArrayCallbackCall(call, incoming, ctx) {
  return getArrayCallbackAnalyzer().analyzeCall(call, incoming, ctx);
}
function analyzeArrayCallbacksInNode(node, incoming, ctx) {
  return getArrayCallbackAnalyzer().analyzeInNode(node, incoming, ctx);
}

function discoverMockContext(fn, checker, sourceFile, functionIndex = null, mockBehaviorOverrides = {}, program = null) {
  return mockPlanner.discover({
    functionNode: fn.node ?? fn,
    checker,
    sourceFile,
    unwrap,
    relativeFile: path.relative(process.cwd(), sourceFile.fileName).split(path.sep).join('/'),
    functionIndex,
    mockBehaviorOverrides,
    program,
  });
}

const functionAnalysisOrchestrator = createFunctionAnalysisOrchestrator({
  ts,
  createFunctionContext,
  createControlFlowAnalyzer,
  createControlFlowPorts: createControlFlowAnalyzerPorts,
  analyzeTernaries,
  createFunctionAnalysisStateStore,
  defaultMaxAlternatives: () => DEFAULT_MAX_ALTERNATIVES,
  getProjectRelativeFile: filename => path.relative(process.cwd(), filename).split(path.sep).join('/'),
});

function analyzeFunction(fn, sourceFile, checker, maxScenarios, generateMcdc = false, generationOptions = {}) {
  return functionAnalysisOrchestrator.analyzeFunction(fn, sourceFile, checker, maxScenarios, generateMcdc, generationOptions);
}



const coverageFeedbackRuntime = createCoverageFeedbackRuntime({ ts, analyzeFunction });
const { runIterativeCoverageFeedback } = coverageFeedbackRuntime;


export { VERSION, formatLine, analyzeFunction, runIterativeCoverageFeedback };
