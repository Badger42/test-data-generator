#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeAnalysisReport } from '../src/reporting/analysis-report-finalizer.mjs';

export function runFinalizeAnalysisReport(argv = process.argv.slice(2), io = console) {
  const positional = [];
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--out') {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) throw new Error('--out requires a file path.');
      output = next;
      index += 1;
    } else if (item.startsWith('-')) {
      throw new Error(`Unknown argument: ${item}`);
    } else positional.push(item);
  }
  if (positional.length !== 2) throw new Error('Usage: node tools/finalize-analysis-report.mjs <analysis-report.json> <analysis-run-form.json> [--out final-analysis-report.json]');
  const analysisPath = path.resolve(positional[0]);
  const formPath = path.resolve(positional[1]);
  const outputPath = path.resolve(output ?? analysisPath.replace(/\.json$/i, '.final.json'));
  if (outputPath === analysisPath || outputPath === formPath) throw new Error('Output path must differ from both input files.');
  const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));
  const form = JSON.parse(fs.readFileSync(formPath, 'utf8'));
  const finalized = finalizeAnalysisReport(analysis, form);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(finalized, null, 2)}\n`, 'utf8');
  io.log(`Final analysis report: ${outputPath}`);
  io.log(`Execution: ${finalized.externalExecution.status}; passed ${finalized.externalExecution.testResults.passed}, failed ${finalized.externalExecution.testResults.failed}, not run ${finalized.externalExecution.testResults.notRun}.`);
  return { status: 'finalized', outputFile: outputPath, report: finalized };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runFinalizeAnalysisReport();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
