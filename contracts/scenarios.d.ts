export type { MockPlan, MockPlanAction, MockPlannerInput, MockPlannerPort, MockBehaviorOverride } from './mocks.js';
import type { AnalysisWarning, MockAction, ScenarioCase, ScenarioTargetRef, SerializedValue } from './domain.js';

export interface AssignmentMaterializationInput {
  baseArguments: unknown[];
  assignments: Map<string, {
    path: Array<string | number>;
    value?: SerializedValue | unknown;
    numericConstraint?: unknown;
    lengthConstraint?: unknown;
  }> | Array<{ path: Array<string | number>; value?: unknown; numericConstraint?: unknown; lengthConstraint?: unknown }>;
  parameterMap: ReadonlyMap<string, { index: number; type?: unknown }>;
  mockBindingMap: ReadonlyMap<string, {
    call?: string;
    callId?: string;
    callExpression?: string;
    isPromise?: boolean;
    awaited?: boolean;
    resolvedType?: unknown;
  }>;
  getParameterDefault?: (parameter: { index: number; type?: unknown }, assignment: unknown) => unknown;
  getMockDefault?: (binding: unknown, assignment: unknown) => unknown;
}

export interface AssignmentMaterializationResult {
  arguments: SerializedValue[];
  mockAssignments: Array<{ localName: string; binding: Record<string, unknown>; value: SerializedValue }>; 
}

export interface AssignmentMaterializer {
  materialize(input: AssignmentMaterializationInput): AssignmentMaterializationResult;
}

export interface ScenarioPayloadFingerprintInput {
  arguments: SerializedValue[];
  mocks?: Array<Partial<MockAction> & Record<string, unknown>>;
}

export interface ScenarioDeduplicationClaim {
  duplicate: boolean;
  fingerprint: string;
}

export interface ScenarioDeduplicator {
  claim(payload: ScenarioPayloadFingerprintInput): ScenarioDeduplicationClaim;
  has(fingerprint: string): boolean;
  size(): number;
  fingerprints(): string[];
}

export interface ScenarioEvidenceInput {
  incoming?: Array<{ assignments: Map<string, unknown>; unsupported?: string[] }>;
  assignments?: Map<string, unknown>;
  unsupported?: string[];
  additionalAssumptions?: string[];
  dataFlowModel?: import('./domain.js').FunctionDataModel;
  sourceSpan?: import('./domain.js').SourceSpan | null;
  target?: Record<string, unknown>;
  evidence?: import('./domain.js').Evidence[];
}

export interface ScenarioEvidenceResult {
  assumptions: string[];
  unsupported: string[];
  warnings: AnalysisWarning[];
  evidence?: import('./domain.js').Evidence[];
}

export interface ScenarioEvidenceBuilder {
  build(input: ScenarioEvidenceInput): ScenarioEvidenceResult;
}

export interface ScenarioBuilderInput {
  id: string;
  functionId: string;
  arguments: SerializedValue[];
  mocks?: MockAction[];
  targets?: ScenarioTargetRef[];
  assumptions?: string[];
  warnings?: AnalysisWarning[];
  fingerprint?: string;
  incoming?: ScenarioEvidenceInput['incoming'];
  assignments?: Map<string, unknown>;
  unsupported?: string[];
  dataFlowModel?: import('./domain.js').FunctionDataModel;
  sourceSpan?: import('./domain.js').SourceSpan | null;
  target?: Record<string, unknown>;
  evidence?: import('./domain.js').Evidence[];
}

export interface ScenarioBuilderPort {
  build(input: ScenarioBuilderInput): ScenarioCase;
}

export interface ScenarioReportAdapterPort {
  project(scenario: ScenarioCase, input: {
    target: Record<string, unknown>;
    mocks?: Array<Record<string, unknown>>;
    unsupported?: string[];
    includeEvidence?: boolean;
  }): Record<string, unknown>;
}

export type { MockAction };
