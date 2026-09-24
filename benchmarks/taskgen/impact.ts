import ts from "typescript";

/**
 * Oracle for the change-impact category: "if export X is removed from F, which
 * files fail to compile?" Answered by actually doing it - F's text is modified in
 * memory (never on disk) and the whole program is re-type-checked. A file is
 * impacted if it gains a diagnostic it didn't have at baseline, so pre-existing
 * errors in a large repo don't leak into the answer.
 *
 * "Removed" means the `export` keyword is removed and the declaration stays.
 * Deleting the declaration outright would also break F's own internal uses, which
 * answers a different question. The keyword is overwritten with spaces rather than
 * cut, so every other character offset in F, and every baseline diagnostic
 * position, stays comparable.
 *
 * Only `export`-modifier declarations are candidates (function, class, interface,
 * type, enum, single-binding const/let/var). `export default` and
 * `export { X }` lists are not handled.
 */

export interface ExportedDeclaration {
  name: string;
  /** [start, end) of each `export` keyword that exports this name - several for overloads. */
  exportKeywordRanges: [number, number][];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export class ImpactOracle {
  readonly program: ts.Program;
  private readonly options: ts.CompilerOptions;
  private readonly rootNames: readonly string[];
  private readonly host: ts.CompilerHost;
  private readonly baseline: Map<string, Set<string>>;

  constructor(tsconfigPath: string) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
    }
    const slash = Math.max(tsconfigPath.lastIndexOf("/"), tsconfigPath.lastIndexOf("\\"));
    const basePath = ts.sys.resolvePath(slash === -1 ? "." : tsconfigPath.slice(0, slash));
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);

    this.options = { ...parsed.options, noEmit: true, incremental: false, composite: false };
    this.rootNames = parsed.fileNames;
    this.host = ts.createCompilerHost(this.options);
    this.program = ts.createProgram(this.rootNames, this.options, this.host);
    this.baseline = diagnosticKeysByFile(this.program);
  }

  sourceFiles(): ts.SourceFile[] {
    return this.program
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile && !this.program.isSourceFileFromExternalLibrary(sf));
  }

  exportedDeclarations(filePath: string): ExportedDeclaration[] {
    const sf = this.getSourceFile(filePath);
    const byName = new Map<string, [number, number][]>();
    for (const stmt of sf.statements) {
      const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
      const exportKw = modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exportKw || modifiers!.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
      const name = declaredName(stmt);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push([exportKw.getStart(sf), exportKw.end]);
    }
    return [...byName].map(([name, exportKeywordRanges]) => ({ name, exportKeywordRanges }));
  }

  /** Absolute paths of files that gain a diagnostic when `name` stops being exported from `filePath`. */
  impactOfRemovingExport(filePath: string, name: string): string[] {
    const target = this.getSourceFile(filePath);
    const decl = this.exportedDeclarations(filePath).find((d) => d.name === name);
    if (!decl) throw new Error(`${name} is not an export-modifier declaration in ${filePath}`);

    let text = target.text;
    for (const [start, end] of decl.exportKeywordRanges) {
      text = text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
    }

    const targetName = normalizePath(target.fileName);
    const host: ts.CompilerHost = {
      ...this.host,
      getSourceFile: (fileName, languageVersion, onError, shouldCreate) =>
        normalizePath(fileName) === targetName
          ? ts.createSourceFile(fileName, text, languageVersion, true)
          : (this.program.getSourceFile(fileName) ??
            this.host.getSourceFile(fileName, languageVersion, onError, shouldCreate)),
    };
    const modified = ts.createProgram({ rootNames: this.rootNames, options: this.options, host, oldProgram: this.program });

    const impacted: string[] = [];
    for (const [file, keys] of diagnosticKeysByFile(modified)) {
      const before = this.baseline.get(file) ?? new Set();
      if ([...keys].some((k) => !before.has(k))) impacted.push(file);
    }
    return impacted.sort();
  }

  private getSourceFile(filePath: string): ts.SourceFile {
    const wanted = normalizePath(filePath);
    const sf = this.sourceFiles().find((s) => normalizePath(s.fileName) === wanted);
    if (!sf) throw new Error(`not in program: ${filePath}`);
    return sf;
  }
}

function declaredName(stmt: ts.Statement): string | undefined {
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)) &&
    stmt.name
  ) {
    return stmt.name.text;
  }
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations;
    if (decls.length === 1 && ts.isIdentifier(decls[0].name)) return decls[0].name.text;
  }
  return undefined;
}

function diagnosticKeysByFile(program: ts.Program): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || program.isSourceFileFromExternalLibrary(sf)) continue;
    const keys = new Set<string>();
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      keys.add(`${d.code}:${d.start}:${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
    out.set(normalizePath(sf.fileName), keys);
  }
  return out;
}
