import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { assertAnalysisReport } from './analysis-report-schema.mjs';
import { ANALYSIS_RUN_FORM_SCHEMA_VERSION } from './analysis-run-form-schema.mjs';

export const ANALYSIS_REPORT_SCHEMA_VERSION = '1.0.0';

function safeJson(value, seen = new WeakSet()) {
  if (value === undefined) return { $type: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => safeJson(item, seen));
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), safeJson(item, seen)]));
  if (value instanceof Set) return [...value].map(item => safeJson(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeJson(item, seen)]));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableStringify(safeJson(value))).digest('hex');
}

function safeText(value, mode, project) {
  let text = String(value ?? '');
  if (mode !== 'include') {
    text = text.replace(/(['\"])(?:\\.|(?!\1)[^\\])*?\1/g, '"<redacted-string>"');
    text = text.replace(/\b[A-Za-z0-9_+/=-]{28,}\b/g, '<redacted-token>');
  }
  if (project?.projectRoot) text = text.split(project.projectRoot).join('<project>');
  return text.slice(0, 2000);
}

function valueShape(value, mode = 'shape', depth = 0) {
  if (mode === 'include') return safeJson(value);
  if (depth > 5) return { type: 'truncated', reason: 'max-depth' };
  const primitiveType = value === null ? 'null' : typeof value;
  if (value === undefined || (value && typeof value === 'object' && value.$undefined === true)) return { type: 'undefined' };
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    const result = { type: primitiveType };
    if (typeof value === 'string') result.length = value.length;
    if (mode === 'hash') result.sha256 = digest(value);
    return result;
  }
  if (Array.isArray(value)) {
    const result = { type: 'array', length: value.length, sample: value.slice(0, 3).map(item => valueShape(item, mode, depth + 1)) };
    if (value.length > 3) result.sampleTruncated = value.length - 3;
    if (mode === 'hash') result.sha256 = digest(value);
    return result;
  }
  const keys = Object.keys(value).sort();
  const result = {
    type: 'object',
    keys: keys.slice(0, 60),
    fields: Object.fromEntries(keys.slice(0, 40).map(key => [key, valueShape(value[key], mode, depth + 1)])),
  };
  if (keys.length > 60) result.keysTruncated = keys.length - 60;
  if (mode === 'hash') result.sha256 = digest(value);
  return result;
}

function relativePath(project, fileName) {
  if (!fileName) return null;
  const normalized = String(fileName).split(path.sep).join('/');
  if (!path.isAbsolute(fileName)) return normalized;
  const relative = project?.getRelativeFileName?.(fileName) ?? path.relative(project?.projectRoot ?? process.cwd(), fileName).split(path.sep).join('/');
  return relative.startsWith('../') || path.isAbsolute(relative) ? `<external>/${path.basename(fileName)}` : relative;
}

function spanSummary(span, project) {
  if (!span) return null;
  return {
    file: relativePath(project, span.file),
    startOffset: Number.isInteger(span.startOffset) ? span.startOffset : null,
    endOffset: Number.isInteger(span.endOffset) ? span.endOffset : null,
    startLine: span.startLine ?? span.line ?? null,
    startColumn: span.startColumn ?? span.column ?? null,
    endLine: span.endLine ?? null,
    endColumn: span.endColumn ?? null,
  };
}

function countBy(items, key) {
  return (items ?? []).reduce((counts, item) => {
    const value = typeof key === 'function' ? key(item) : item?.[key];
    const label = String(value ?? 'unknown');
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
}

function summarizeEvidence(evidence = [], project, mode = 'shape') {
  return {
    total: evidence.length,
    byStatus: countBy(evidence, 'status'),
    items: evidence.slice(0, 80).map(item => ({
      source: item.source ?? null,
      status: item.status ?? 'unknown',
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      code: item.code ?? null,
      message: item.message == null ? null : safeText(item.message, mode, project),
      sourceSpan: spanSummary(item.sourceSpan, project),
    })),
    truncated: Math.max(0, evidence.length - 80),
  };
}

function summarizeMock(mock, mode, project) {
  const valueFields = ['resolvedValue', 'value', 'error', 'sequence', 'cases', 'defaultAction'];
  const values = {};
  for (const key of valueFields) {
    if (Object.prototype.hasOwnProperty.call(mock, key)) values[key] = valueShape(mock[key], mode);
  }
  return {
    call: mock.call ?? mock.callExpression ?? mock.callId ?? 'unknown-call',
    callId: mock.callId ?? null,
    behavior: mock.behavior ?? null,
    inputDependencies: mock.inputDependencies ?? [],
    dataFlowEffects: (mock.dataFlowEffects ?? []).map(effect => ({ kind: effect.kind, path: effect.path, certainty: effect.certainty, propagation: effect.propagation })),
    contextIds: mock.contextIds ?? [],
    evidence: summarizeEvidence(mock.evidence ?? [], project, mode),
    values,
  };
}

function summarizeScenario(scenario, mode, project, includeSourceText) {
  const target = scenario.target ?? {};
  return {
    id: scenario.id,
    target: {
      branchId: target.branchId ?? null,
      kind: target.kind ?? null,
      outcome: typeof target.outcome === 'boolean' ? target.outcome : null,
      line: target.line ?? target.coverageLine ?? null,
      column: target.column ?? target.coverageColumn ?? null,
      coverageOutcomeIndex: target.coverageOutcomeIndex ?? null,
      runtimeDecisionId: target.runtimeDecisionId ?? null,
      ...(includeSourceText ? { condition: target.condition ?? null, sourceText: target.sourceText ?? null } : {}),
    },
    arguments: (scenario.arguments ?? []).map(value => valueShape(value, mode)),
    mocks: (scenario.mocks ?? []).map(mock => summarizeMock(mock, mode, project)),
    externalCalls: (scenario.externalCalls ?? []).map(call => ({
      call: safeText(call.call ?? call.callExpression ?? 'unknown-call', mode, project),
      callId: call.callId ?? null,
      callSiteId: call.callSiteId ?? null,
      classification: call.classification ?? 'external-dependency',
      executionContext: call.executionContext ?? 'unknown',
      reachability: call.reachability ?? 'unknown',
      functionScope: call.functionScope ?? null,
      sourceSpan: spanSummary(call.sourceSpan, project),
      callArguments: (call.callArguments ?? []).map(argument => ({
        index: argument.index,
        expression: safeText(argument.expression ?? '', mode, project),
        kind: argument.kind ?? 'unknown',
        ...(argument.path ? { path: argument.path } : {}),
        ...(Object.prototype.hasOwnProperty.call(argument, 'value') ? { value: valueShape(argument.value, mode) } : {}),
        resolvedFromScenario: Boolean(argument.resolvedFromScenario),
        confidence: argument.confidence ?? null,
      })),
      mock: call.mock ? {
        behavior: call.mock.behavior ?? null,
        ...(Object.prototype.hasOwnProperty.call(call.mock, 'value') ? { value: valueShape(call.mock.value, mode) } : {}),
        source: call.mock.source ?? null,
        confidence: call.mock.confidence ?? null,
        appliedAutomatically: false,
        setupRequired: true,
      } : null,
    })),
    assumptions: scenario.assumptions ?? [],
    unsupported: scenario.unsupported ?? [],
    evidence: summarizeEvidence(scenario.evidence ?? [], project, mode),
  };
}

function summarizeDataFlow(model, project, mode = 'shape') {
  if (!model) return null;
  const cfgNodes = model.controlFlowGraph?.nodes ?? [];
  const cfgEdges = model.controlFlowGraph?.edges ?? [];
  const scalar = model.ssa?.versioned ?? {};
  const memory = model.memorySsa ?? {};
  const points = model.pointsTo ?? {};
  const summaries = model.functionSummaries ?? [];
  const callSites = model.callSites ?? [];
  const contexts = model.interprocedural?.contextSensitive?.contexts ?? [];
  const paths = Object.entries(points.pointsTo ?? {});
  return {
    schemaVersion: '1.0',
    properties: (model.properties ?? []).map(item => ({
      path: item.path?.canonical ?? [item.path?.rootName, ...(item.path?.segments ?? [])].filter(Boolean).join('.'),
      kind: item.kind ?? 'unknown', confidence: item.confidence ?? 'unknown',
      optional: Boolean(item.optional), nullable: Boolean(item.nullable), evidenceCount: item.evidence?.length ?? 0,
    })),
    aliases: {
      total: (model.aliases ?? []).length,
      byRelation: countBy(model.aliases ?? [], 'relation'),
      items: (model.aliases ?? []).slice(0, 100).map(item => ({ alias: item.alias, target: item.target?.canonical ?? null, relation: item.relation, confidence: item.confidence, immutable: item.immutable })),
    },
    cfg: {
      nodeCount: cfgNodes.length, edgeCount: cfgEdges.length,
      loops: model.controlFlowAnalysis?.naturalLoops?.length ?? 0,
      nodes: cfgNodes.slice(0, 1000).map(node => ({ id: node.id, kind: node.kind ?? node.type ?? null, sourceSpan: spanSummary(node.sourceSpan, project) })),
      edges: cfgEdges.slice(0, 2000).map(edge => ({ from: edge.from ?? edge.source, to: edge.to ?? edge.target, kind: edge.kind ?? edge.type ?? null, label: edge.label ?? null })),
      diagnostics: model.controlFlowGraph?.diagnostics ?? [],
    },
    flow: {
      definitions: model.flowAnalysis?.definitions?.length ?? 0,
      uses: model.flowAnalysis?.useBindings?.length ?? 0,
      phiCandidates: model.flowAnalysis?.phiCandidates?.length ?? 0,
      diagnostics: model.flowAnalysis?.diagnostics ?? [],
    },
    scalarSsa: {
      algorithm: scalar.algorithm ?? null,
      definitions: scalar.definitions?.length ?? 0,
      definitionDetails: (scalar.definitions ?? []).slice(0, 1000).map(item => ({
        id: item.id, symbolId: item.symbolId, name: item.name, version: item.version,
        kind: item.kind, nodeId: item.nodeId, expression: mode === 'include' ? item.expressionText ?? null : undefined,
        sourceSpan: spanSummary(item.sourceSpan, project), operands: item.operands ?? [],
      })),
      phiNodes: scalar.phiNodes?.length ?? 0,
      phiDetails: (scalar.phiNodes ?? []).slice(0, 1000).map(item => ({
        id: item.id, symbolId: item.symbolId, name: item.name, version: item.version,
        nodeId: item.nodeId, kind: item.kind, complete: item.complete, inputs: item.inputs ?? [],
      })),
      useBindings: scalar.useBindings?.length ?? 0,
      useDetails: (scalar.useBindings ?? []).slice(0, 1500).map(item => ({
        id: item.id, nodeId: item.nodeId, symbolId: item.symbolId, name: item.name,
        value: item.value, resolution: item.resolution, reachingDefinitionFacts: item.reachingDefinitionFacts ?? [],
      })),
      unresolvedUses: (scalar.useBindings ?? []).filter(item => !item.value).length,
      convergence: scalar.convergence ?? null,
      diagnostics: scalar.diagnostics ?? [],
    },
    memorySsa: {
      algorithm: memory.algorithm ?? null,
      locations: memory.locations?.length ?? 0,
      locationDetails: (memory.locations ?? []).slice(0, 1000),
      reads: (memory.accesses ?? []).filter(item => item.kind === 'read').length,
      writes: (memory.accesses ?? []).filter(item => item.kind === 'write').length,
      accesses: (memory.accesses ?? []).slice(0, 2000).map(item => ({
        id: item.id ?? item.accessId ?? null, kind: item.kind ?? null, location: item.location ?? item.locationKey ?? null,
        path: item.path ?? null, certainty: item.certainty ?? null, pointerResolution: item.pointerResolution ?? null,
        sourceSpan: spanSummary(item.sourceSpan, project),
      })),
      definitions: memory.definitions?.length ?? 0,
      definitionDetails: (memory.definitions ?? []).slice(0, 1000).map(item => ({ id: item.id, location: item.location ?? item.locationKey ?? null, version: item.version, nodeId: item.nodeId, kind: item.kind, sourceSpan: spanSummary(item.sourceSpan, project) })),
      phiNodes: memory.phiNodes?.length ?? 0,
      phiDetails: (memory.phiNodes ?? []).slice(0, 1000),
      aliasSummary: memory.pointsTo ?? null,
      diagnostics: memory.diagnostics ?? [],
      limits: memory.limits ?? {},
    },
    pointsTo: {
      algorithm: points.algorithm ?? null,
      allocationSites: points.allocations?.length ?? 0,
      symbols: paths.length,
      targetRelations: paths.reduce((total, [, sites]) => total + (sites?.length ?? 0), 0),
      unknownSymbols: points.unknownSymbols?.length ?? 0,
      unknownHeapFields: points.unknownHeapFields?.length ?? 0,
      aliasPairs: (points.aliasPairs ?? []).slice(0, 1000),
      pointsToMap: Object.fromEntries(paths.slice(0, 1000)),
      heapFields: Object.fromEntries(Object.entries(points.heapFields ?? {}).slice(0, 1000)),
      constraints: points.constraints ?? {},
      convergence: points.convergence ?? null,
      diagnostics: points.diagnostics ?? [],
      limits: points.limits ?? {},
    },
    interprocedural: {
      algorithm: model.interprocedural?.algorithm ?? null,
      projectFunctionSummaries: summaries.length,
      callSites: callSites.length,
      calls: callSites.map(call => ({
        callId: call.callId, callee: call.callee,
        resolution: call.resolution ?? 'unknown',
        targetFunctionId: call.targetFunctionId ?? null,
        knownPure: Boolean(call.knownPure),
        argumentDependencies: (call.arguments ?? []).map(argument => argument.dependencies ?? []),
        sourceSpan: spanSummary(call.sourceSpan, project),
      })),
      summaries: summaries.slice(0, 200).map(summary => ({
        functionId: summary.functionId, symbolId: summary.symbolId, name: summary.name,
        sourceSpan: spanSummary(summary.sourceSpan, project),
        returnType: summary.returnType, purity: summary.purity, confidence: summary.confidence,
        inlineable: Boolean(summary.inlineable), calls: summary.calls?.length ?? 0,
        returnFacts: summary.returns?.length ?? 0, effects: summary.effects?.length ?? 0,
      })),
      rootEffects: (model.interprocedural?.rootEffects ?? []).slice(0, 1000).map(effect => ({
        kind: effect.kind, path: effect.path ?? null, certainty: effect.certainty ?? null,
        propagation: effect.propagation ?? null, contextId: effect.contextId ?? null,
      })),
      contexts: {
        count: contexts.length,
        maxDepthObserved: contexts.reduce((max, item) => Math.max(max, item.depth ?? 0), 0),
        effects: contexts.reduce((total, item) => total + (item.transitiveEffects?.length ?? 0), 0),
        unresolvedBindings: contexts.reduce((total, item) => total + (item.argumentBindings ?? []).filter(binding => !binding.resolved).length, 0),
        diagnostics: model.interprocedural?.contextSensitive?.diagnostics ?? [],
      },
      diagnostics: model.interprocedural?.diagnostics ?? [],
    },
    arrayPipelines: (model.arrayPipelines ?? []).map(item => ({
      id: item.id, collection: item.collection ?? item.collectionPath ?? null,
      stages: (item.stages ?? []).map(stage => ({ method: stage.method, kind: stage.kind ?? null })),
      provenance: item.provenance ?? null,
      warningCount: item.warnings?.length ?? 0,
      warnings: item.warnings ?? [],
    })),
    loopFlow: {
      loops: model.loopFlow?.loops?.length ?? 0,
      summaries: (model.loopFlow?.loops ?? []).map(item => ({ kind: item.kind, stateTransfer: item.stateTransfer, confidence: item.confidence, nodeCount: item.nodeIds?.length ?? 0 })),
      reduceFlows: model.reduceFlows?.length ?? 0,
    },
    warnings: (model.warnings ?? []).map(item => ({ code: item.code ?? null, severity: item.severity ?? 'warning', message: item.message == null ? null : safeText(item.message, mode, project), sourceSpan: spanSummary(item.sourceSpan, project) })),
  };
}

function projectGraph(project, maxFiles = 300) {
  const ts = project.compilerApi;
  const program = project.program;
  const sourceFiles = program.getSourceFiles().filter(file => !file.isDeclarationFile && !file.fileName.split(path.sep).join('/').includes('/node_modules/'));
  const fileNames = new Set(sourceFiles.map(file => path.resolve(file.fileName)));
  const fileDigests = sourceFiles.map(file => {
    const text = typeof file.getFullText === 'function' ? file.getFullText() : file.text ?? '';
    return { file: relativePath(project, file.fileName), sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), lineCount: String(text).split(/\r?\n/).length };
  });
  const projectFingerprint = digest(fileDigests.slice().sort((a, b) => String(a.file).localeCompare(String(b.file))));
  const imports = [];
  for (const file of sourceFiles) {
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        let resolvedFile = null;
        let resolution = 'unresolved';
        try {
          const resolved = ts.resolveModuleName(specifier, file.fileName, program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
          if (resolved && fileNames.has(path.resolve(resolved))) {
            resolvedFile = relativePath(project, resolved);
            resolution = 'project-file';
          } else if (resolved) {
            resolvedFile = '<external-module>';
            resolution = 'external-module';
          } else if (specifier.startsWith('node:')) {
            resolvedFile = '<node-builtin>';
            resolution = 'node-builtin';
          }
        } catch { /* resolution detail remains explicit as unresolved */ }
        const safeSpecifier = path.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('file://') ? '<absolute-import>' : specifier;
        imports.push({ from: relativePath(project, file.fileName), specifier: safeSpecifier, to: resolvedFile, resolved: resolution !== 'unresolved', resolution, kind: ts.isImportDeclaration(node) ? 'import' : 're-export' });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const entries = project.functionIndex?.entries ?? [];
  const functions = entries.map(entry => {
    const sourceFile = entry.sourceFile ?? entry.node?.getSourceFile?.();
    const start = entry.node?.getStart?.(sourceFile) ?? 0;
    const position = sourceFile?.getLineAndCharacterOfPosition?.(start);
    return {
      functionId: entry.functionId, symbolId: entry.symbolId, name: entry.name,
      file: relativePath(project, entry.relativeFile ?? sourceFile?.fileName),
      line: position ? position.line + 1 : null,
      column: position ? position.character + 1 : null,
      exported: Boolean(entry.exported),
    };
  });
  const syntaxDiagnostics = [];
  try {
    for (const diagnostic of program.getSyntacticDiagnostics().slice(0, 200)) {
      const file = diagnostic.file;
      const position = file && diagnostic.start != null ? file.getLineAndCharacterOfPosition(diagnostic.start) : null;
      syntaxDiagnostics.push({
        code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category] ?? 'unknown',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, 1000),
        file: file ? relativePath(project, file.fileName) : null,
        line: position ? position.line + 1 : null, column: position ? position.character + 1 : null,
      });
    }
  } catch { /* diagnostics are supplementary; don't fail report generation */ }
  return {
    root: relativePath(project, project.absoluteFile),
    config: { detected: Boolean(project.configFile), file: project.configFile ? relativePath(project, project.configFile) : null },
    sourceFileCount: sourceFiles.length,
    fingerprint: projectFingerprint,
    fileDigests: fileDigests.slice(0, maxFiles),
    fileDigestsTruncated: Math.max(0, fileDigests.length - maxFiles),
    files: sourceFiles.slice(0, maxFiles).map(file => relativePath(project, file.fileName)),
    filesTruncated: Math.max(0, sourceFiles.length - maxFiles),
    imports: { total: imports.length, resolved: imports.filter(item => item.resolved).length, project: imports.filter(item => item.resolution === 'project-file').length, external: imports.filter(item => item.resolution === 'external-module' || item.resolution === 'node-builtin').length, unresolved: imports.filter(item => !item.resolved).length, edges: imports.slice(0, 1000) },
    functionIndex: {
      total: functions.length,
      exported: functions.filter(item => item.exported).length,
      files: new Set(functions.map(item => item.file)).size,
      functions: functions.slice(0, 1000),
      truncated: Math.max(0, functions.length - 1000),
      diagnostics: (project.functionIndex?.diagnostics ?? []).slice(0, 100),
    },
    typescriptDiagnostics: syntaxDiagnostics,
    compilerOptions: {
      target: program.getCompilerOptions().target ?? null,
      module: program.getCompilerOptions().module ?? null,
      moduleResolution: program.getCompilerOptions().moduleResolution ?? null,
      strict: program.getCompilerOptions().strict ?? false,
      strictNullChecks: program.getCompilerOptions().strictNullChecks ?? false,
      allowJs: program.getCompilerOptions().allowJs ?? false,
      checkJs: program.getCompilerOptions().checkJs ?? false,
      jsx: program.getCompilerOptions().jsx ?? null,
    },
  };
}

function summarizeCoverage(feedback, mode = 'shape', project = null) {
  if (!feedback) return { status: 'not-run', note: 'Coverage feedback was not requested. Fill externalExecution after running the generated tests.' };
  const execution = feedback.execution ?? {};
  const results = execution.testResults ?? feedback.testResults ?? null;
  const testResults = results ? {
    success: results.success ?? null,
    total: results.numTotalTests ?? results.total ?? null,
    passed: results.numPassedTests ?? results.passed ?? null,
    failed: results.numFailedTests ?? results.failed ?? null,
    pending: results.numPendingTests ?? results.pending ?? null,
    cases: (results.cases ?? []).map(item => ({
      id: item.id, status: item.status,
      failureMessages: (item.failureMessages ?? []).slice(0, 3).map(message => safeText(String(message).split('\n')[0], mode, project).slice(0, 500)),
    })),
    error: results.error == null ? null : safeText(results.error, mode, project),
  } : null;
  return {
    status: feedback.status ?? 'unknown',
    provider: feedback.provider ?? null,
    totals: feedback.totals ?? null,
    branchCoverage: feedback.branchCoverage ?? null,
    executedScenarioCount: feedback.executedScenarioCount ?? execution.generatedCases ?? null,
    testResults,
    testBatching: execution.testBatching ? {
      strategy: execution.testBatching.strategy,
      inputCases: execution.testBatching.inputCases,
      batchedCases: execution.testBatching.batchedCases,
      individualCases: execution.testBatching.individualCases,
      batchCount: execution.testBatching.batchCount,
      averageBatchSize: execution.testBatching.averageBatchSize,
      diagnostics: execution.testBatching.diagnostics ?? [],
      batches: (execution.testBatching.batches ?? []).map(batch => ({
        id: batch.id, scenarioIds: batch.scenarioIds ?? [], size: batch.size ?? (batch.scenarioIds ?? []).length,
        signature: batch.signature ? {
          version: batch.signature.version ?? null, target: batch.signature.target ?? null,
          exportPath: batch.signature.exportPath ?? null, environment: batch.signature.environment ?? null,
          lifecycle: batch.signature.lifecycle ?? null, runtime: batch.signature.runtime ?? null,
          setupProfileConfigured: Boolean(batch.signature.setupProfile), mockMethods: batch.signature.mockMethods ?? [],
        } : null,
      })),
      individual: (execution.testBatching.individual ?? []).map(item => ({ id: item.id, reason: safeText(item.reason, mode, project) })),
    } : null,
    scenarioCoverage: execution.scenarioCoverage ? {
      totalCases: execution.scenarioCoverage.totalCases,
      passedCases: execution.scenarioCoverage.passedCases ?? null,
      casesWithBranchAttribution: execution.scenarioCoverage.casesWithBranchAttribution,
      casesWithoutBranchAttribution: execution.scenarioCoverage.casesWithoutBranchAttribution ?? null,
      cases: (execution.scenarioCoverage.cases ?? []).slice(0, 1000).map(item => ({
        caseId: item.caseId, status: item.status,
        arguments: (item.arguments ?? []).map(value => valueShape(value, mode)),
        mocks: (item.mocks ?? []).map(mock => summarizeMock(mock, mode, project)),
        references: (item.references ?? []).slice(0, 100).map(reference => ({
          type: reference.type ?? null, branchId: reference.branchId ?? null, decisionId: reference.decisionId ?? null,
          pairId: reference.pairId ?? null, sourceSpan: spanSummary(reference.sourceSpan, project),
        })),
        decisionExecutions: (item.decisionExecutions ?? []).map(run => ({
          decisionId: run.decisionId, decisionOutcome: run.decisionOutcome,
          callbackContext: run.callbackContext ?? null,
          conditions: run.conditions ?? {},
        })),
        coveredBranchOutcomes: item.coveredBranchOutcomes ?? [],
        mcdcPairSides: item.mcdcPairSides ?? [],
      })),
      truncated: Math.max(0, (execution.scenarioCoverage.cases ?? []).length - 1000),
    } : null,
    mcdcPairs: (execution.mcdcPairs ?? []).map(pair => ({
      pairId: pair.pairId, decisionId: pair.decisionId, conditionId: pair.conditionId,
      conditionFalseCaseId: pair.conditionFalseCaseId, conditionTrueCaseId: pair.conditionTrueCaseId,
      status: pair.status, bothScenariosPassed: pair.bothScenariosPassed,
      inputChecks: {
        conditionFalse: pair.inputChecks?.conditionFalse?.status ?? null,
        conditionTrue: pair.inputChecks?.conditionTrue?.status ?? null,
      },
      runtimeChecks: {
        conditionFalse: pair.runtimeChecks?.conditionFalse?.status ?? null,
        conditionTrue: pair.runtimeChecks?.conditionTrue?.status ?? null,
      },
    })),
    mcdc: feedback.mcdc ? {
      generatedIndependencePairs: feedback.mcdc.generatedIndependencePairs,
      inputPairVerification: feedback.mcdc.inputPairVerification,
      runtimeInstrumentation: feedback.mcdc.runtimeInstrumentation ? {
        enabled: feedback.mcdc.runtimeInstrumentation.enabled,
        decisionsDiscovered: feedback.mcdc.runtimeInstrumentation.decisionsDiscovered,
        decisionsInstrumented: feedback.mcdc.runtimeInstrumentation.decisionsInstrumented,
        conditionsDiscovered: feedback.mcdc.runtimeInstrumentation.conditionsDiscovered,
        conditionsInstrumented: feedback.mcdc.runtimeInstrumentation.conditionsInstrumented,
        recordedDecisionExecutions: feedback.mcdc.runtimeInstrumentation.recordedDecisionExecutions,
        verifiedIndependencePairs: feedback.mcdc.runtimeInstrumentation.verifiedIndependencePairs,
        shortCircuitInferencePairs: feedback.mcdc.runtimeInstrumentation.shortCircuitInferencePairs,
        skipped: feedback.mcdc.runtimeInstrumentation.skipped ?? [],
      } : null,
      verificationScope: feedback.mcdc.verificationScope ?? null,
    } : null,
    staticBranchTargets: (feedback.staticBranchTargets ?? []).slice(0, 2000).map(target => ({
      id: target.id, branchId: target.branchId ?? null, kind: target.kind ?? null, outcome: target.outcome ?? null,
      line: target.line ?? target.sourceLine ?? null, coverageStatus: target.coverageStatus ?? null, mappingStatus: target.mappingStatus ?? null,
    })),
    uncoveredBranchEntries: (feedback.uncoveredBranchEntries ?? []).slice(0, 500).map(item => ({ id: item.id, type: item.type, location: item.location, counters: item.counters })),
    iterative: feedback.iterative ? {
      enabled: feedback.iterative.enabled,
      strategy: feedback.iterative.strategy ?? null,
      maxIterations: feedback.iterative.maxIterations,
      iterations: feedback.iterative.iterations ?? [],
      totalAdditionalScenarios: feedback.iterative.totalAdditionalScenarios ?? 0,
      stopReason: feedback.iterative.stopReason ?? null,
      goalReached: feedback.iterative.goalReached ?? null,
    } : null,
    minimalTestSet: feedback.minimalTestSet ? {
      status: feedback.minimalTestSet.status,
      algorithm: feedback.minimalTestSet.algorithm,
      candidateCases: feedback.minimalTestSet.candidateCases,
      selectedCases: feedback.minimalTestSet.selectedCases,
      exactMinimumProven: feedback.minimalTestSet.exactMinimumProven,
      obligationsCovered: feedback.minimalTestSet.obligationsCovered,
      totalObligations: feedback.minimalTestSet.totalObligations,
    } : null,
    errors: [feedback.error, feedback.coverageError, feedback.jest?.launchError].filter(Boolean).map(item => safeText(item, mode, project)),
    jest: feedback.jest ? { exitCode: feedback.jest.exitCode, signal: feedback.jest.signal ?? null, hasStdout: Boolean(feedback.jest.stdoutTail), hasStderr: Boolean(feedback.jest.stderrTail), coverageError: feedback.jest.coverageError ?? null } : null,
  };
}

function sumFunctionStats(functionResults, sessions) {
  const snapshots = (sessions ?? []).map(session => session?.analysisSnapshot ?? {});
  const summary = {
    functions: functionResults.length,
    scenarios: functionResults.reduce((total, fn) => total + (fn.scenarios?.length ?? 0), 0),
    branchOutcomes: functionResults.reduce((total, fn) => total + (fn.summary?.branchOutcomesFound ?? 0), 0),
    unsupportedBranchTargets: functionResults.reduce((total, fn) => total + (fn.summary?.branchesWithUnsupportedExpressions ?? 0), 0),
    warnings: functionResults.reduce((total, fn) => total + (fn._dataFlowModel?.warnings?.length ?? 0), 0),
    mcdcPairs: functionResults.reduce((total, fn) => total + (fn.mcdc?.independencePairsFound ?? 0), 0),
    mockActions: functionResults.reduce((total, fn) => total + (fn.scenarios ?? []).reduce((sum, scenario) => sum + (scenario.mocks?.length ?? 0), 0), 0),
    constraint: { irAttempts: 0, irSolved: 0, legacyFallback: 0, fallbackReasons: {} },
  };
  for (const snapshot of snapshots) {
    const stats = snapshot.constraintStats ?? {};
    summary.constraint.irAttempts += stats.irAttempts ?? 0;
    summary.constraint.irSolved += stats.irSolved ?? 0;
    summary.constraint.legacyFallback += stats.legacyFallback ?? 0;
    for (const [reason, count] of Object.entries(stats.fallbackReasons ?? {})) summary.constraint.fallbackReasons[reason] = (summary.constraint.fallbackReasons[reason] ?? 0) + count;
  }
  return summary;
}

export function createAnalysisReportBuilder() {
  function build(input) {
    const { project, report, functionResults = [], functionUnits = [], sessions = [], args = {} } = input;
    if (!project || !report) throw new TypeError('AnalysisReportBuilder requires project and generation report.');
    const mode = ['shape', 'hash', 'include'].includes(input.valueMode) ? input.valueMode : 'shape';
    const maxScenarios = Math.max(1, Math.min(5000, input.maxScenarios ?? 500));
    const functions = functionResults.map((analysis, index) => {
      const model = analysis._dataFlowModel ?? null;
      const snapshot = sessions[index]?.analysisSnapshot ?? {};
      const functionUnit = functionUnits[index] ?? {};
      const detailedScenarios = (analysis.scenarios ?? []).slice(0, maxScenarios);
      return {
        functionId: functionUnit.functionId ?? model?.functionId ?? null,
        name: analysis.name ?? functionUnit.name ?? 'anonymous',
        file: functionUnit.relativeFile ?? project.relativeFile,
        sourceLocation: analysis.sourceLocation ?? null,
        summary: safeJson(analysis.summary ?? {}),
        inferredProperties: (analysis.inferredProperties ?? []).map(item => ({ path: item.path, inferredType: item.inferredType, confidence: item.confidence, evidenceCount: item.evidence?.length ?? 0 })),
        dataFlow: summarizeDataFlow(model, project, mode),
        constraintStats: safeJson(snapshot.constraintStats ?? analysis._constraintStats ?? {}),
        unsupportedBranches: (snapshot.unsupportedBranches ?? analysis.unsupportedBranches ?? []).slice(0, 500).map(item => ({
          branchId: item.branchId ?? item.target?.branchId ?? null,
          outcome: item.outcome ?? null, reason: item.reason == null && item.message == null ? null : safeText(item.reason ?? item.message, mode, project),
          sourceSpan: spanSummary(item.sourceSpan ?? item.target?.sourceSpan, project),
        })),
        mcdc: analysis.mcdc ? {
          criterion: analysis.mcdc.criterion,
          decisionsAnalyzed: analysis.mcdc.decisionsAnalyzed,
          conditionsAnalyzed: analysis.mcdc.conditionsAnalyzed,
          independencePairsFound: analysis.mcdc.independencePairsFound,
          conditionsWithoutIndependencePair: analysis.mcdc.conditionsWithoutIndependencePair ?? [],
          decisions: (analysis.mcdc.decisions ?? []).map(decision => ({
            decisionId: decision.decisionId ?? decision.id,
            sourceSpan: spanSummary(decision.sourceSpan, project),
            conditions: (decision.conditions ?? []).map(condition => ({
              conditionId: condition.conditionId ?? condition.id,
              independencePairs: (condition.independencePairs ?? []).map(pair => ({
                pairId: pair.pairId, status: pair.status ?? 'static-candidate',
                falseCaseId: pair.conditionFalseCaseId, trueCaseId: pair.conditionTrueCaseId,
              })),
            })),
          })),
        } : null,
        scenarios: detailedScenarios.map(scenario => summarizeScenario(scenario, mode, project, mode === 'include')),
        scenarioIndex: { ids: (analysis.scenarios ?? []).map(scenario => scenario.id), count: (analysis.scenarios ?? []).length },
        scenarioGroups: {
          count: (analysis.scenarioGroups ?? []).length,
          groups: (analysis.scenarioGroups ?? []).slice(0, 500).map(group => ({
            id: group.id,
            fingerprint: group.fingerprint,
            size: group.size,
            scenarioIds: group.scenarioIds,
            targets: group.targets,
            arguments: (group.arguments ?? []).map(value => valueShape(value, mode)),
            mocks: (group.mocks ?? []).map(mock => summarizeMock(mock, mode, project)),
          })),
          truncated: Math.max(0, (analysis.scenarioGroups ?? []).length - 500),
        },
        scenarioCount: (analysis.scenarios ?? []).length,
        scenariosTruncated: Math.max(0, (analysis.scenarios ?? []).length - detailedScenarios.length),
        arrayPipelines: summarizeDataFlow(model, project, mode)?.arrayPipelines ?? [],
        mockTemplates: (analysis.mockTemplates ?? []).map(item => ({
          call: safeText(item.call, mode, project),
          callId: item.callId ?? null,
          callSiteId: item.callSiteId ?? null,
          classification: item.classification?.kind ?? null,
          nested: Boolean(item.nested),
          executionContext: item.executionContext ?? 'function-body',
          reachability: item.reachability ?? 'direct-static-call-site',
          sourceSpan: spanSummary(item.sourceSpan, project),
          callArguments: (item.callArguments ?? []).map(argument => ({
            index: argument.index,
            expression: safeText(argument.expression ?? '', mode, project),
            kind: argument.kind ?? 'unknown',
            ...(argument.path ? { path: argument.path } : {}),
            ...(Object.prototype.hasOwnProperty.call(argument, 'value') ? { value: valueShape(argument.value, mode) } : {}),
          })),
          mockBehavior: item.mockBehavior ?? null,
          suggestedValues: (item.suggestedResolvedValues ?? []).map(value => valueShape(value, mode)),
          suggestedValueCount: item.suggestedResolvedValues?.length ?? 0,
        })),
      };
    });

    const callEdges = [];
    const seenCallIds = new Set();
    const addCallEdge = edge => {
      if (!edge.callId || seenCallIds.has(edge.callId)) return;
      seenCallIds.add(edge.callId);
      callEdges.push(edge);
    };
    for (const [indexInResults, analysis] of functionResults.entries()) {
      const model = analysis._dataFlowModel;
      const callerId = functionUnits[indexInResults]?.functionId ?? model?.functionId ?? null;
      for (const summary of model?.functionSummaries ?? []) {
        for (const call of summary.calls ?? []) addCallEdge({
          callerFunctionId: summary.functionId, callerName: summary.name,
          callId: call.callId, callee: call.callee,
          targetFunctionId: call.resolvedSummaryId ?? null,
          resolution: call.resolvedSummaryId ? 'project-function-summary'
            : call.knownPure ? 'pure-intrinsic'
            : call.resolution ?? call.classification ?? 'external-or-unresolved',
          classification: call.resolution ?? call.classification ?? null,
          knownPure: Boolean(call.knownPure),
          argumentDependencies: (call.arguments ?? []).map(argument => argument.dependencies ?? []),
          sourceSpan: spanSummary(call.sourceSpan, project),
        });
      }
      // Add root call-site facts as well; the ID set removes duplicates when
      // the selected function is already represented in project summaries.
      for (const call of model?.callSites ?? []) addCallEdge({
        callerFunctionId: callerId, callId: call.callId, callee: call.callee,
        targetFunctionId: call.targetFunctionId ?? null,
        resolution: call.resolution ?? call.classification ?? 'unknown',
        classification: call.resolution ?? call.classification ?? null,
        knownPure: Boolean(call.knownPure),
        sourceSpan: spanSummary(call.sourceSpan, project),
      });
    }

    const sourceHash = createHash('sha256').update(project.sourceText ?? '').digest('hex');
    const projectDetails = projectGraph(project);
    const coverage = summarizeCoverage(report.coverageFeedback, mode, project);
    const diagnosticReport = {
      reportType: 'branch-scenarios-analysis-report',
      schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
      reportId: digest({ version: report.generator.version, sourceHash, projectFingerprint: projectDetails.fingerprint, generatedAt: report.generatedAt, functions: functionResults.map(item => item.name) }).slice(0, 24),
      generatedAt: new Date().toISOString(),
      generator: { name: report.generator.name, version: report.generator.version },
      environment: {
        node: process.version, platform: process.platform, architecture: process.arch,
        typescript: project.compilerApi?.version ?? null,
      },
      project: {
        ...projectDetails,
        source: { file: relativePath(project, project.absoluteFile), language: report.sourceLanguage, sha256: sourceHash, projectFingerprint: projectDetails.fingerprint, bytes: Buffer.byteLength(project.sourceText ?? ''), lineCount: String(project.sourceText ?? '').split(/\r?\n/).length },
      },
      run: {
        generatedAt: report.generatedAt,
        functionFilter: args.functionName ?? null,
        allFunctions: Boolean(args.all),
        maxScenarios: args.maxScenarios ?? 40,
        constraintEngine: args.constraintEngine ?? 'hybrid',
        constraintDiagnostics: Boolean(args.constraintDiagnostics),
        mcdc: Boolean(args.mcdc),
        includeEvidence: Boolean(args.includeEvidence),
        coverageFeedback: Boolean(args.coverageFeedback),
        coverageGoal: args.coverageGoal ?? 100,
        coverageIterations: args.coverageIterations ?? 3,
        coverageProvider: args.coverageProvider ?? 'v8',
        minimalSuite: Boolean(args.minimalSuite),
        testBatching: { enabled: args.testBatching !== false, minSize: args.testBatchMinSize ?? 2, maxSize: args.testBatchMaxSize ?? 100 },
        valueMode: mode,
      },
      summary: sumFunctionStats(functionResults, sessions),
      functions,
      callGraph: { edgeCount: callEdges.length, edges: callEdges.slice(0, 2000), truncated: Math.max(0, callEdges.length - 2000) },
      execution: coverage,
      externalExecution: {
        status: !report.coverageFeedback ? 'not-recorded' : report.coverageFeedback.status === 'coverage-loaded' ? 'coverage-loaded' :
          report.coverageFeedback.execution?.testResults ? 'captured-by-generator' : 'attempted-no-test-results',
        runner: report.coverageFeedback?.runner ?? null,
        executedAt: report.coverageFeedback?.execution?.testResults ? new Date().toISOString() : null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        testCommand: null,
        environment: null,
        testResults: report.coverageFeedback?.execution?.testResults ? {
          total: report.coverageFeedback.execution.testResults.numTotalTests ?? null,
          passed: report.coverageFeedback.execution.testResults.numPassedTests ?? null,
          failed: report.coverageFeedback.execution.testResults.numFailedTests ?? null,
          pending: report.coverageFeedback.execution.testResults.numPendingTests ?? null,
          cases: (report.coverageFeedback.execution.testResults.cases ?? []).map(item => ({
            executionCaseId: item.id,
            scenarioIds: (item.references ?? []).map(reference => reference?.scenarioId).filter(Boolean),
            ...(item.references?.length === 1 ? { scenarioId: item.references[0].scenarioId } : {}),
            status: item.status,
            failureMessages: (item.failureMessages ?? []).slice(0, 3).map(message => safeText(String(message).split('\n')[0], mode, project)),
          })),
        } : null,
        coverage: report.coverageFeedback?.totals ? { provider: report.coverageFeedback.provider ?? null, ...safeJson(report.coverageFeedback.totals) } : null,
        failingTests: (report.coverageFeedback?.execution?.testResults?.cases ?? []).filter(item => item.status === 'failed').map(item => ({
          executionCaseId: item.id,
          scenarioIds: (item.references ?? []).map(reference => reference?.scenarioId).filter(Boolean),
          ...(item.references?.length === 1 ? { scenarioId: item.references[0].scenarioId } : {}),
          messages: (item.failureMessages ?? []).slice(0, 3).map(message => safeText(String(message).split('\n')[0], mode, project)),
        })),
        notes: [],
        executionForm: { formType: 'branch-scenarios-execution-results-form', schemaVersion: ANALYSIS_RUN_FORM_SCHEMA_VERSION, status: 'ready-to-fill', file: null },
        fillInWhenRunningTestsManually: ['runner', 'startedAt', 'completedAt', 'durationMs', 'testCommand', 'testResults', 'coverage', 'failingTests', 'notes'],
      },
      diagnostics: {
        project: project.functionIndex?.diagnostics ?? [],
        functions: functions.flatMap(fn => [
          ...(fn.dataFlow?.warnings ?? []).map(item => ({ functionId: fn.functionId, ...item })),
          ...fn.unsupportedBranches.map(item => ({ functionId: fn.functionId, severity: 'warning', code: 'UNSUPPORTED_BRANCH', ...item })),
          ...fn.constraintStats?.fallbackReasons ? Object.entries(fn.constraintStats.fallbackReasons).map(([reason, count]) => ({ functionId: fn.functionId, severity: 'info', code: 'CONSTRAINT_FALLBACK', reason, count })) : [],
        ]),
      },
      privacy: {
        valueMode: mode,
        valuesIncluded: mode === 'include',
        sourceCodeIncluded: false,
        sourceExpressionsIncluded: mode === 'include',
        absolutePathsIncluded: false,
        note: mode === 'include' ? 'Scenario arguments and selected condition/source expressions are included; full source files are never embedded. Review for personal, confidential or secret values before sharing.' : 'Scenario values are represented by shape metadata; absolute paths and source file contents are omitted.',
      },
      assistantHandoff: {
        purpose: 'Use this report to diagnose unsupported analysis, incorrect scenarios, mock classification, Data Flow/Points-to/SSA propagation, per-scenario coverage and test failures.',
        recommendedAttachments: ['this analysis report', 'the smallest relevant source files with secrets removed', 'the exact command used to generate/run tests', 'Jest config/setup when coverage or mocks behave unexpectedly'],
        reviewQuestions: [
          'Which generated scenarios are incorrect or redundant?',
          'Are project-local calls incorrectly mocked or external dependencies left unmocked?',
          'Are Points-to, Memory SSA, interprocedural summaries and array provenance consistent with source behavior?',
          'Which branches remain unsupported or uncovered, and why?',
          'Do test.each batches preserve independent mock state?',
        ],
      },
    };
    return assertAnalysisReport(diagnosticReport);
  }
  return Object.freeze({ build });
}
