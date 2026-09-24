import ts from "typescript";

/**
 * Ground-truth runtime edge extraction (plan step 2). Compiles the target repo for
 * real and reads which module specifiers the emitter actually kept. This is the
 * independent oracle behind every "runtime vs type-only" claim in the top-level
 * README (nest's 2-cycle count, the emitDecoratorMetadata fix, the
 * verbatimModuleSyntax fix) - it deliberately does NOT import anything from
 * src/indexer or src/engine, because its whole job is to catch bugs in exactly
 * that code, not agree with it by construction. Only the TypeScript compiler API
 * itself is shared, since there is no way to get real emit output without it.
 *
 * The target repo's own `module`/`moduleResolution` are left untouched rather than
 * forced to CommonJS. An earlier version of this forced `module: CommonJS`
 * unconditionally, which sounds harmless but isn't: TS hard-errors
 * (`TS5110: module must be set to 'NodeNext' when moduleResolution is
 * 'NodeNext'`) the moment moduleResolution is NodeNext/Node16 - exactly the
 * setting nest and TypeORM both use. Forcing moduleResolution away from NodeNext
 * to dodge that would silently break `.js`-suffixed relative specifiers, which
 * that mode resolves back to `.ts` source and classic resolution does not.
 * Leaving both alone sidesteps the whole problem: a CJS-detected file still emits
 * `require(...)` calls exactly as before, and an ESM-detected file keeps its
 * `import`/`export` declarations verbatim (real ESM has no require() at all, so
 * that IS the surviving-edge signal there) - so both are scanned for below.
 * `noEmitOnError` is forced off so a single type error elsewhere in a large repo
 * can't silently zero out the whole edge list.
 */

export interface EmittedEdge {
  /** Absolute source path (not the emitted .js path) of the importing file. */
  from: string;
  /** Absolute source path of the file whose module the emitted output actually references. */
  to: string;
}

export interface EmittedEdgesResult {
  edges: EmittedEdge[];
  fileCount: number;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function computeEmittedEdges(tsconfigPath: string): EmittedEdgesResult {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`
    );
  }

  const slash = Math.max(tsconfigPath.lastIndexOf("/"), tsconfigPath.lastIndexOf("\\"));
  const basePath = ts.sys.resolvePath(slash === -1 ? "." : tsconfigPath.slice(0, slash));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);

  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: false,
    noEmitOnError: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
  };

  const program = ts.createProgram(parsed.fileNames, options);
  const host = ts.createCompilerHost(options);

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sf));

  const edges: EmittedEdge[] = [];

  for (const sourceFile of sourceFiles) {
    let emittedText: string | undefined;
    // Emitting one file at a time (rather than the whole program in one call)
    // gives an unambiguous source -> emitted-text pairing without having to
    // separately map output file names back to input files.
    program.emit(sourceFile, (_fileName, text) => {
      if (emittedText === undefined) emittedText = text;
    });
    if (emittedText === undefined) continue; // e.g. an ambient .d.ts-only input

    const emittedSource = ts.createSourceFile(
      sourceFile.fileName + ".emit.js",
      emittedText,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS
    );

    const specifiers = [
      ...collectTopLevelRequireSpecifiers(emittedSource),
      ...collectSurvivingEsmSpecifiers(emittedSource),
    ];

    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, options, host);
      if (!resolved.resolvedModule || resolved.resolvedModule.isExternalLibraryImport) continue;
      edges.push({
        from: normalizePath(sourceFile.fileName),
        to: normalizePath(resolved.resolvedModule.resolvedFileName),
      });
    }
  }

  return { edges, fileCount: sourceFiles.length };
}

/**
 * Walk the EMITTED (not source) file's AST for `require("literal")` calls that
 * execute at module top level - i.e. not nested inside any function. A dynamic
 * `import()` always downlevels to `Promise.resolve().then(() => require(X))`
 * under CommonJS output (verified against a real tsc build before writing this):
 * the require() sits inside an arrow function, so it's excluded by the same rule
 * that excludes any other nested require. Counting it would turn every lazy or
 * optional load into a hard initialization-order edge that doesn't really exist.
 */
function collectTopLevelRequireSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  const isFunctionBoundary = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node);

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    const nowInsideFunction = insideFunction || isFunctionBoundary(node);

    if (
      !nowInsideFunction &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }

    ts.forEachChild(node, (child) => visit(child, nowInsideFunction));
  };

  visit(sourceFile, false);
  return specifiers;
}

/**
 * When a file emits as real ESM (module: NodeNext/ESNext detects it that way, or
 * `module` is a plain ES target), erasure has already happened by the time this
 * runs - a surviving `import`/`export ... from` declaration IS the edge, verbatim.
 * Import/export declarations are only legal at a module's top level to begin with
 * (unlike `require(...)`, which is an ordinary call expression that can appear
 * anywhere), so scanning `sourceFile.statements` directly - no function-boundary
 * tracking needed - can't pick up a dynamic `import()` by construction: that stays
 * a CallExpression, a different AST shape entirely.
 */
function collectSurvivingEsmSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const stmt of sourceFile.statements) {
    const moduleSpecifier = ts.isImportDeclaration(stmt)
      ? stmt.moduleSpecifier
      : ts.isExportDeclaration(stmt)
        ? stmt.moduleSpecifier
        : undefined;
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}
