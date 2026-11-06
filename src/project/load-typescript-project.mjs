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
    // Without a tsconfig, analyse common bundler-style source projects,
    // including extensionless relative imports used by Vue/Vite/Webpack apps.
    // An explicit project config still takes precedence below.
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
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
  const syntaxDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (syntaxDiagnostics.length) {
    const details = syntaxDiagnostics.slice(0, 10).map(diagnostic => {
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const where = position ? `${position.line + 1}:${position.character + 1}` : 'unknown position';
      return `${where} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
    const remaining = syntaxDiagnostics.length > details.length ? `\n…and ${syntaxDiagnostics.length - details.length} more syntax error(s).` : '';
    throw new SyntaxError(`Source file has ${syntaxDiagnostics.length} syntax error(s):\n${details.join('\n')}${remaining}`);
  }

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
