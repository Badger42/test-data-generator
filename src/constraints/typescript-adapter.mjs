import ts from 'typescript';
import { compileTypescriptCondition } from './compile-typescript-condition.mjs';

/** Parser adapter; the IR/compiler core remains independent of TypeScript. */
export function compileConditionNode(node, options = {}) {
  return compileTypescriptCondition(node, ts, options);
}
export { ts };
