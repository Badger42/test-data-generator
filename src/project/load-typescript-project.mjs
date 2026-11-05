import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { buildProjectFunctionIndex } from './function-index.mjs';

/**
 * TypeScript Compiler API adapter. This is the only project-loading module
 * responsible for creating Program and TypeChecker instances.
 *
 * @param {{ file: string, configFile?: string }} request
 */
export function loadTypescriptProject(request) {
  const absoluteFile = path.resolve(request.file);
  if (!fs.existsSync(absoluteFile)) throw new Error(`Source file does not exist: ${absoluteFile}`);

  let configPath = request.configFile ? path.resolve(request.configFile) : undefined;
  if (!configPath) {
    const configNames = /\.(?:jsx?|mjs|cjs)$/i.test(absoluteFile)
      ? ['jsconfig.json', 'tsconfig.json']
      : ['tsconfig.json', 'jsconfig.json'];
    for (const configName of configNames) {
      configPath = ts.findConfigFile(path.dirname(absoluteFile), ts.sys.fileExists, configName);
      if (configPath) break;
    }
  }

  let options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: true,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    strict: false,
    strictNullChecks: true,
    noEmit: true,
  };
  let rootNames = [absoluteFile];
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
    options = { ...options, ...parsed.options, allowJs: true, strictNullChecks: true, noEmit: true };
    rootNames = [...new Set([...parsed.fileNames, absoluteFile])];
  }

  const program = ts.createProgram({ rootNames, options });
  const sourceFile = program.getSourceFile(absoluteFile);
  if (!sourceFile) throw new Error(`Could not load source file: ${absoluteFile}`);

  const projectRoot = configPath ? path.dirname(configPath) : process.cwd();
  const relativeFile = path.relative(projectRoot, absoluteFile).split(path.sep).join('/');

  const project = {
    program,
    compilerApi: ts,
    checker: program.getTypeChecker(),
    sourceFile,
    absoluteFile,
    relativeFile,
    configFile: configPath,
    projectRoot,
    sourceText: sourceFile.text,
    getRelativeFileName: filename => path.relative(projectRoot, filename).split(path.sep).join('/'),
  };
  project.functionIndex = buildProjectFunctionIndex(project);
  return project;
}

/** Stable project loader adapter shape consumed by the TypeScript analysis runtime. */
export function loadProgram(fileName, configFile) {
  return loadTypescriptProject({ file: fileName, configFile });
}
