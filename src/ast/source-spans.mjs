/** Return a stable one-based line/column for a TypeScript AST node. */
export function formatLine(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

/** Return a source span DTO; callers must not expose AST nodes in reports. */
export function formatNodeSpan(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    startOffset: start,
    endOffset: end,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character + 1,
    sourceText: node.getText(sourceFile),
  };
}

/** Coverage anchor metadata compatible with the v0.18 JSON schema. */
export function coverageAnchorMetadata(sourceFile, node, kind) {
  const position = formatLine(sourceFile, node);
  const span = formatNodeSpan(sourceFile, node);
  return {
    coverageAnchor: kind,
    coverageLine: position.line,
    coverageColumn: position.column,
    coverageStartOffset: span.startOffset,
    coverageEndOffset: span.endOffset,
  };
}
