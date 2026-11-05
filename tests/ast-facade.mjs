import assert from 'node:assert/strict';
import ts from 'typescript';
import { createAstFacade } from '../src/ast/ast-facade.mjs';
import { discoverFunctions } from '../src/project/discover-functions.mjs';

const ast = createAstFacade(ts);
const source = ts.createSourceFile('fixture.ts', `const input = { user: { age: 21 }, rows: [{ score: 4 }] };\nconst age = input.user.age;\nconst negative = -2;\n`, ts.ScriptTarget.Latest, true);
const declarations = source.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations);
const inputDecl = declarations[0];
const ageDecl = declarations[1];
const negativeDecl = declarations[2];
const undefinedSentinel = Symbol('undefined');

assert.deepEqual(ast.getPath(ageDecl.initializer), ['input', 'user', 'age']);
assert.deepEqual(ast.getPathWithAliases(ageDecl.name, new Map([['age', { kind: 'path', path: ['input', 'user', 'age'] }]])), ['input', 'user', 'age']);
assert.deepEqual(ast.readLiteral(negativeDecl.initializer, undefinedSentinel), { ok: true, value: -2 });
assert.deepEqual(ast.readLiteral(ts.factory.createIdentifier('undefined'), undefinedSentinel), { ok: true, value: undefinedSentinel });
const printer = ts.createPrinter();
const generated = ast.createPathAccessNode(['input', 'rows', '0', 'score']);
assert.equal(printer.printNode(ts.EmitHint.Expression, generated, source), 'input.rows[0].score');
assert.deepEqual(ast.getPath(inputDecl.name), ['input']);

const functionsSource = ts.createSourceFile('anything.ts', 'function target(x: number) { return x > 0; }', ts.ScriptTarget.Latest, true);
const discoveredA = discoverFunctions(functionsSource, { relativeFile: 'src/anything.ts' });
const discoveredB = discoverFunctions(functionsSource, { relativeFile: 'src/anything.ts' });
assert.equal(discoveredA[0].functionId, 'src/anything.ts::target@0');
assert.equal(discoveredA[0].functionId, discoveredB[0].functionId);
assert.equal(discoveredA[0].sourceSpan.startLine, 1);
assert.ok(!discoveredA[0].functionId.includes('/mnt/') && !discoveredA[0].functionId.includes('C:'));
console.log('AST facade tests passed.');
