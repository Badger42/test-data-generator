import fs from 'node:fs';
import path from 'node:path';

export function writeJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return absolutePath;
}

export function writeMinimalSuiteJson(filePath, report) {
  return writeJson(filePath, {
    generator: report.generator,
    source: report.source,
    sourceLanguage: report.sourceLanguage,
    generatedAt: report.generatedAt,
    minimalTestSet: report.coverageFeedback.minimalTestSet,
  });
}
