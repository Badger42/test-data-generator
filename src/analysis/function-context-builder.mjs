/**
 * Builds the per-function adapter context from explicit front-end services.
 * TypeScript compiler objects stay local to this TypeScript-aware boundary.
 */
export function createFunctionContextBuilder(dependencies) {
  const {
    ts,
    pathResolver,
    typeModelProvider,
    propertyInference,
    discoverMockContext,
    dataFlowAnalyzer,
    createExpressionAliasResolver,
    ConstraintSolver,
    defaultMaxAlternatives,
    getProjectRelativeFile,
  } = dependencies;

  if (!ts || !pathResolver || !typeModelProvider || !propertyInference || !dataFlowAnalyzer || !getProjectRelativeFile) {
    throw new TypeError('FunctionContextBuilder requires TypeScript, path, type, inference and data-flow services.');
  }

  function createFunctionContext(fn, sourceFile, checker, maxScenarios, generateMcdc = false, generationOptions = {}) {
    const parameters = [];
    const parameterMap = new Map();
    const parameterNames = fn.node.parameters
      .filter(parameter => ts.isIdentifier(parameter.name))
      .map(parameter => parameter.name.text);

    fn.node.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) {
        parameters.push({ name: parameter.name.getText(sourceFile), type: checker.typeToString(checker.getTypeAtLocation(parameter)), supported: false });
        return;
      }
      const type = checker.getTypeAtLocation(parameter);
      const name = parameter.name.text;
      parameterMap.set(name, { index, type, parameter });
      parameters.push({ name, type: checker.typeToString(type), supported: true });
    });

    const mockDiscovery = discoverMockContext(
      fn, checker, sourceFile,
      generationOptions.projectFunctionIndex ?? generationOptions.project?.functionIndex ?? null,
      generationOptions.mockBehaviorOverrides ?? {},
    );
    const localMockMap = mockDiscovery.bindings;
    const pathAliases = pathResolver.collectLocalPathAliases(fn.node);
    const fallbackDataFlow = generationOptions.dataFlowModel && generationOptions.dataFlowCompilerBindings
      ? null
      : dataFlowAnalyzer.analyzeWithCompilerBindings({
        project: generationOptions.project ?? {
          sourceFile,
          checker,
          relativeFile: getProjectRelativeFile(sourceFile.fileName),
          functionIndex: generationOptions.projectFunctionIndex ?? null,
          getRelativeFileName: getProjectRelativeFile,
        },
        functionUnit: {
          functionId: fn.functionId ?? `${sourceFile.fileName}::${fn.name}@${fn.node.getStart(sourceFile)}`,
          name: fn.name,
          astNode: fn.node,
        },
      });
    const expressionFacts = generationOptions.dataFlowCompilerBindings ?? fallbackDataFlow.compilerFacts;
    const expressionAliasResolver = createExpressionAliasResolver(expressionFacts, checker);
    const dataFlowModel = generationOptions.dataFlowModel ?? fallbackDataFlow.dataModel;
    const localConstants = pathResolver.collectLocalNumericConstants(fn.node);
    const inferredPaths = propertyInference.inferPropertyModel(fn.node, sourceFile, parameterNames, pathAliases);
    const typeContext = { parameterMap, localMockMap, checker, location: fn.node };

    for (const item of inferredPaths.values()) {
      const actualType = typeModelProvider.getType(item.path.split('.'), typeContext);
      const knownKind = typeModelProvider.classifyType(actualType, checker);
      if (knownKind) {
        item.kind = knownKind;
        item.confidence = 'declared';
        item.evidence.push(`Confirmed by TypeScript/JSDoc type: ${checker.typeToString(actualType)}`);
        item.priority = 10;
      }
    }

    const baseArgs = fn.node.parameters.map(parameter => {
      if (!ts.isIdentifier(parameter.name)) return null;
      const type = checker.getTypeAtLocation(parameter);
      const value = typeModelProvider.defaultValueForType(type, checker, parameter);
      const isUnknown = typeModelProvider.typeHasFlag(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown);
      const inferredValue = propertyInference.inferredDefaultForPath([parameter.name.text], inferredPaths);
      return isUnknown && inferredValue !== undefined ? inferredValue : value;
    });

    const inferredProperties = [...inferredPaths.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ path: propertyPath, kind, confidence, evidence }) => ({ path: propertyPath, inferredType: kind, confidence, evidence }));

    if (dataFlowModel) {
      const modelProperties = new Map((dataFlowModel.properties ?? []).map(property => [
        `${property.path.rootName}.${property.path.segments.join('.')}`, property,
      ]));
      for (const [propertyPath, inferred] of inferredPaths) {
        const [rootName, ...segments] = propertyPath.split('.');
        const key = `${rootName}.${segments.join('.')}`;
        const current = modelProperties.get(key) ?? {
          path: { rootKind: 'parameter', rootName, segments, canonical: `${rootName}.${segments.join('.')}` },
          kind: 'unknown', confidence: 'low', evidence: [],
        };
        const normalizedKind = inferred.kind === 'sequence' ? 'array' : inferred.kind;
        modelProperties.set(key, {
          ...current,
          kind: current.kind === 'unknown' ? normalizedKind : current.kind,
          evidence: [...new Set([...(current.evidence ?? []), ...inferred.evidence])],
        });
      }
      dataFlowModel.properties = [...modelProperties.values()];
    }

    generationOptions.analysisState?.dispatch({ type: 'analysis.constraint-mode-set', mode: generationOptions.constraintEngine ?? 'hybrid' });

    return {
      fn,
      sourceFile,
      checker,
      parameterMap,
      localMockMap,
      mockTemplates: mockDiscovery.templates,
      mockCallSites: mockDiscovery.callSites,
      includeEvidence: generationOptions.includeEvidence === true,
      inferredPaths,
      inferredProperties,
      analysisState: generationOptions.analysisState,
      maxAlternatives: generationOptions.maxAlternatives ?? defaultMaxAlternatives(),
      parameters,
      baseArgs,
      maxScenarios,
      branchSeen: new Set(),
      branchOutcomeSeen: new Set(),
      pathAliases,
      expressionFacts,
      expressionAliasResolver,
      dataFlowModel,
      localConstants,
      dataFlowLoopPlans: [],
      arrayCallbackSeen: new Set(),
      arrayPipelineSeen: new Set(),
      activeAnalysisMetadata: {},
      generateMcdc,
      mcdcDecisionSeen: new Set(),
      constraintEngine: generationOptions.constraintEngine ?? 'hybrid',
      coverageExpansion: generationOptions.coverageExpansion === true,
      mockBehaviorOverrides: generationOptions.mockBehaviorOverrides ?? {},
      constraintSolver: new ConstraintSolver(),
      typeModelProvider,
    };
  }

  return Object.freeze({ createFunctionContext });
}
