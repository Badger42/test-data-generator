import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import { createAstFacade } from '../src/ast/ast-facade.mjs';
import { createPathResolver } from '../src/ast/path-resolver.mjs';
import { createTypeModelProvider } from '../src/inference/type-model-provider.mjs';
import { createPropertyInference } from '../src/inference/property-inference.mjs';

const sourceText = `
interface Input {
  count: number;
  enabled: boolean;
  name: string;
  optional?: string;
}
export function sample(input: Input) {
  const count = input.count;
  if (count > 2 && input.enabled && input.name === 'ready') return true;
  return false;
}
`;
const fileName = path.resolve('/virtual/type-path-inference.ts');
const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
const originalFileExists = host.fileExists.bind(host);
const originalReadFile = host.readFile.bind(host);
host.fileExists = file => path.resolve(file) === fileName || originalFileExists(file);
host.readFile = file => path.resolve(file) === fileName ? sourceText : originalReadFile(file);
host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
  path.resolve(file) === fileName
    ? ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TS)
    : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
const program = ts.createProgram([fileName], options, host);
const checker = program.getTypeChecker();
const sourceFile = program.getSourceFile(fileName);
const functionNode = sourceFile.statements.find(ts.isFunctionDeclaration);
assert.ok(functionNode);

const astFacade = createAstFacade(ts);
const pathResolver = createPathResolver({ ts, astFacade });
const aliasMap = pathResolver.collectLocalPathAliases(functionNode);
assert.deepEqual(aliasMap.get('count'), { kind: 'path', path: ['input', 'count'] });
const countNode = functionNode.body.statements[1].expression.left.left.left;
assert.deepEqual(pathResolver.getPathWithAliases(countNode, aliasMap), ['input', 'count']);
const ifStatement = functionNode.body.statements.find(ts.isIfStatement);
const rewrittenCondition = pathResolver.substituteKnownAliases(ifStatement.expression, aliasMap);
assert.deepEqual(pathResolver.getPath(rewrittenCondition.left.left.left), ['input', 'count'], 'known local aliases must be lowered to their source path');
const literalAliasCondition = ts.factory.createBinaryExpression(
  ts.factory.createIdentifier('minimum'), ts.SyntaxKind.GreaterThanToken,
  ts.factory.createNumericLiteral(0),
);
const rewrittenLiteralAlias = pathResolver.substituteKnownAliases(literalAliasCondition, new Map([['minimum', { kind: 'constant', value: 3 }]]));
assert.equal(rewrittenLiteralAlias.left.kind, ts.SyntaxKind.NumericLiteral);
assert.equal(Number(rewrittenLiteralAlias.left.text), 3);

const typeProvider = createTypeModelProvider(ts);
const parameter = functionNode.parameters[0];
const parameterType = checker.getTypeAtLocation(parameter);
const parameterMap = new Map([['input', { index: 0, type: parameterType, parameter }]]);
const typeContext = { parameterMap, localMockMap: new Map(), checker, location: functionNode };
const countType = typeProvider.getType(['input', 'count'], typeContext);
assert.equal(typeProvider.classifyType(countType, checker), 'number');
assert.equal(typeProvider.getDefaultValue(['input', 'count'], typeContext), 1);
assert.deepEqual(typeProvider.defaultValueForType(parameterType, checker, parameter), {
  count: 1,
  enabled: false,
  name: 'test',
});
assert.equal(typeProvider.classify(['input', 'enabled'], typeContext), 'boolean');

const propertyInference = createPropertyInference({
  ts,
  unwrap: pathResolver.unwrapExpression,
  getPathWithAliases: pathResolver.getPathWithAliases,
  getPathAndLiteralWithAliases: (left, right, aliases = new Map()) => pathResolver.getPathAndLiteralWithAliases(left, right, aliases),
  getTwoPathsWithAliases: pathResolver.getTwoPathsWithAliases,
  getLiteral: node => pathResolver.readLiteral(node, undefined),
  getLoopVariableName: pathResolver.getLoopVariableName,
  getLoopInitialValue: pathResolver.getLoopInitialValue,
  findLengthCollectionPath: pathResolver.findLengthCollectionPath,
  getArrayReceiverModel: () => null,
  isFunctionLikeCallback: node => Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))),
  getCallbackPredicateExpression: () => null,
  evaluateReduceExpression: () => ({ ok: false }),
  deriveMappedItemAlias: () => null,
});
const inferred = propertyInference.inferPropertyModel(functionNode, sourceFile, ['input'], aliasMap);
assert.equal(inferred.get('input.count')?.kind, 'number');
assert.equal(inferred.get('input.enabled')?.kind, 'boolean');
assert.equal(inferred.get('input.name')?.kind, 'string');
assert.equal(propertyInference.inferredDefaultForPath(['input'], inferred).count, 1);

console.log('Type/Path/Inference tests passed: TypeScript path aliases, declared type lookup, defaults and usage-based inference verified.');
