import ts from 'typescript';

function sourceSpan(sourceFile, node, relativeFile) {
  const startOffset = node.getStart(sourceFile);
  const endOffset = node.getEnd();
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(endOffset);
  return {
    file: relativeFile,
    startOffset,
    endOffset,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function isFunctionExpression(node) {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function propertyName(node, sourceFile) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return node.getText(sourceFile);
}

/**
 * Discover supported function-like declarations. AST references are internal
 * to the project/analysis front-end; stable identity is independent of the
 * machine's absolute file path.
 */
export function discoverFunctions(sourceFile, options = {}) {
  const relativeFile = options.relativeFile ?? sourceFile.fileName.split(/[\\/]/).slice(-1)[0];
  const found = [];
  function add(name, node) {
    const span = sourceSpan(sourceFile, node, relativeFile);
    found.push({
      name,
      functionId: `${relativeFile}::${name}@${span.startOffset}`,
      sourceSpan: span,
      node,
      astNode: node,
      body: node.body,
    });
  }
  function visit(node) {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) add(node.name.text, node);
      else if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) add('default', node);
    } else if (ts.isVariableDeclaration(node) && isFunctionExpression(node.initializer)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile);
      add(name, node.initializer);
      return;
    } else if (ts.isPropertyAssignment(node) && isFunctionExpression(node.initializer)) {
      add(propertyName(node.name, sourceFile), node.initializer);
      return;
    } else if (ts.isExportAssignment(node) && isFunctionExpression(node.expression)) {
      add('default', node.expression);
      return;
    } else if (ts.isMethodDeclaration(node) && node.body) {
      add(propertyName(node.name, sourceFile), node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/** Historical helper name retained as an application-facing alias. */
export const collectFunctionNodes = discoverFunctions;
