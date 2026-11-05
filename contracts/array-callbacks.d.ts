import type { ControlFlowPathSolution, AstFunctionContext } from './control-flow.js';

export type ArrayCallbackMethod =
  | 'forEach' | 'map' | 'flatMap' | 'some' | 'every' | 'filter'
  | 'find' | 'findIndex' | 'findLast' | 'findLastIndex'
  | 'sort' | 'toSorted' | 'reduce';

export interface ArrayPipelineStageDescriptor {
  method: string;
  call: import('typescript').CallExpression;
  callback?: import('typescript').ArrowFunction | import('typescript').FunctionExpression | null;
  depth?: number;
  start?: number;
}

export interface ArrayCallbackDescriptor {
  call: import('typescript').CallExpression;
  method: ArrayCallbackMethod;
  collectionPath: string[];
  pipeline: ArrayPipelineStageDescriptor[];
  callback: import('typescript').ArrowFunction | import('typescript').FunctionExpression;
  isReduce: boolean;
  hasInitialValue: boolean;
  initialValue: import('typescript').Expression | null;
}

export interface ArrayCallbackDiscoveryPort {
  getDescriptor(
    call: import('typescript').CallExpression,
    context: AstFunctionContext,
  ): ArrayCallbackDescriptor | null;
}

export interface ArrayCallbackAnalyzerPort {
  analyzeInNode(
    node: import('typescript').Node,
    incoming: ControlFlowPathSolution[],
    context: AstFunctionContext,
  ): void;
}

export interface ReduceIterationSpec {
  arrayValue: unknown[];
  accumulatorAlias: { kind: 'path'; path: string[] } | { kind: 'constant'; value: unknown } | null;
  stateKey: string | null;
}

export interface ReduceStateInterpreterPort {
  evaluateExpression(node: import('typescript').Expression, environment: Map<string, unknown>): { ok: true; value: unknown } | { ok: false };
  evaluateCallback(descriptor: ArrayCallbackDescriptor, accumulator: unknown, item: unknown, index: number, context: AstFunctionContext): { ok: true; value: unknown } | { ok: false };
  getIterationSpecs(descriptor: ArrayCallbackDescriptor, iterationIndex: number, itemValue: unknown, context: AstFunctionContext): ReduceIterationSpec[];
}

export interface ArrayPipelineMapping {
  alias: unknown;
  aliases: Map<string, unknown>;
  trace: Array<Record<string, unknown>>;
}

export interface ArrayPipelineContext extends ArrayPipelineMapping {
  itemAlias: unknown;
  filterSolutions: ControlFlowPathSolution[];
  requiredSourceIndexes: number[];
}

export interface ArrayPipelineComposerPort {
  mapElementThroughStages(descriptor: ArrayCallbackDescriptor, sourceIndex: number, stageLimit: number, context: AstFunctionContext): ArrayPipelineMapping;
  getPipelineContext(descriptor: ArrayCallbackDescriptor, itemIndex: number, context: AstFunctionContext, callbackIndex?: number): ArrayPipelineContext;
}
