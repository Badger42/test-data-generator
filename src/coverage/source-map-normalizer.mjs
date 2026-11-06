/** Translate Istanbul locations from an instrumented sibling back to original source. */
export function createSourceMapNormalizer({ fs, path, platform = process.platform }) {
function lineStartsForText(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function lineColumnToOffset(lineStarts, line, column) {
  if (!Number.isInteger(line) || line < 1 || line > lineStarts.length) return null;
  return lineStarts[line - 1] + Math.max(0, Number(column) || 0);
}

function offsetToLineColumn(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return { line: lineIndex + 1, column: offset - lineStarts[lineIndex] };
}

function remapGeneratedOffsetToOriginal(generatedOffset, insertionEvents) {
  let removedLength = 0;
  for (const event of insertionEvents) {
    if (generatedOffset >= event.generatedStart && generatedOffset < event.generatedEnd) return event.originalOffset;
    if (event.generatedEnd <= generatedOffset) removedLength += event.generatedEnd - event.generatedStart;
  }
  return Math.max(0, generatedOffset - removedLength);
}

function remapCoverageMapForInstrumentedSource(coverageMap, instrumentedPath, originalPath, sourceText, instrumentation) {
  const instrumentedCanonical = canonicalCoveragePath(instrumentedPath);
  const matchingEntry = Object.entries(coverageMap ?? {}).find(([fileName]) => canonicalCoveragePath(fileName) === instrumentedCanonical);
  if (!matchingEntry) return { coverageMap, remapped: false, coveragePath: null };
  const [coveragePath, rawEntry] = matchingEntry;
  const entry = JSON.parse(JSON.stringify(rawEntry));
  const generatedLineStarts = lineStartsForText(instrumentation.generatedSource ?? '');
  const originalLineStarts = lineStartsForText(sourceText);
  function remapLocation(location) {
    if (!location) return;
    for (const key of ['start', 'end']) {
      const point = location[key];
      if (!point) continue;
      const generatedOffset = lineColumnToOffset(generatedLineStarts, point.line, point.column);
      if (generatedOffset === null) continue;
      const originalOffset = remapGeneratedOffsetToOriginal(generatedOffset, instrumentation.insertionEvents);
      location[key] = offsetToLineColumn(originalLineStarts, Math.min(originalOffset, sourceText.length));
    }
  }
  for (const branch of Object.values(entry.branchMap ?? {})) {
    remapLocation(branch.loc);
    for (const location of branch.locations ?? []) remapLocation(location);
  }
  for (const statement of Object.values(entry.statementMap ?? {})) remapLocation(statement);
  for (const fn of Object.values(entry.fnMap ?? {})) {
    remapLocation(fn.loc);
    remapLocation(fn.decl);
  }
  // Istanbul's compact line counters are keyed only by generated line number;
  // there is no location metadata with which to translate them safely. Force
  // the report builder to reconstruct line counters from the remapped statementMap.
  delete entry.l;
  entry.path = originalPath;
  const nextMap = { ...coverageMap, [originalPath]: entry };
  delete nextMap[coveragePath];
  return { coverageMap: nextMap, remapped: true, coveragePath };
}
function canonicalCoveragePath(fileName) {
  let absolute = path.resolve(fileName);
  try { absolute = fs.realpathSync.native(absolute); } catch { /* Coverage may refer to a generated or removed path. */ }
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}


  return { lineStartsForText, lineColumnToOffset, offsetToLineColumn, remapGeneratedOffsetToOriginal, remapCoverageMapForInstrumentedSource, canonicalCoveragePath };
}
