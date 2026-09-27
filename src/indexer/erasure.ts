import ts from "typescript";

/**
 * Value-position analysis: does an import binding survive into the emitted JS?
 *
 * `is_type_only` used to mean "the source wrote the `type` keyword". That is a
 * proxy, not the rule. TypeScript erases an import whose bindings are used only
 * in type position regardless of the keyword, so a codebase that writes plain
 * `import { Foo }` for pure types (nestjs/nest does, ~89% of its statements) had
 * every one of those edges counted as a runtime edge - which is what made
 * findCircularDependencies over-report nest's runtime cycles 7 vs a measured 3.
 *
 * So the question this module answers is the emitter's question: is any binding
 * of this import ever referenced from a value position in this file?
 *
 * One wrinkle the position rules alone get wrong: with `emitDecoratorMetadata`, a
 * *decorated* declaration's parameter/property/return types are re-emitted as
 * `design:paramtypes`/`design:type` metadata, so those imports survive despite only
 * ever appearing in type position. An edge-level diff against emitted output found
 * exactly 3 such cases in nestjs/nest, all `@Injectable()` classes taking a
 * constructor dependency - and this is the dangerous direction, since a missed
 * runtime edge can hide a real cycle. So metadata positions count as value uses
 * when the option is on.
 *
 * Known remaining gap, in the SAFE direction: a `const enum` is inlined, so its
 * import vanishes from the emitted JS even though the source uses it as a value
 * (22 such edges in nest). Those are reported as runtime edges here, which can only
 * over-report a cycle, never hide one - and whether they really vanish depends on
 * `preserveConstEnums`/`isolatedModules`, so staying conservative is correct.
 *
 * `verbatimModuleSyntax` (and its two deprecated predecessors,
 * `importsNotUsedAsValues: "preserve"|"error"` and `preserveValueImports`) turn off
 * value-position elision entirely: under these flags the compiler keeps every
 * import/re-export except the ones explicitly marked with the `type` modifier,
 * regardless of how (or whether) the binding is used in the file. Running
 * value-position analysis anyway is the DANGEROUS direction - it would erase a
 * plain `import { Foo }` used only in type position that the compiler actually
 * emits, hiding a real runtime cycle. So `isErasureDisabledByFlag` gates both this
 * module's own walk and `reExportHasValueMeaning` below; callers still apply the
 * explicit `type` keyword themselves (index.ts already does, per edge/clause).
 */
export interface ErasureAnalysis {
  /** True if `declarationName` (an import/default/namespace binding) is referenced
   *  from at least one value position in the file it was declared in. */
  isUsedAsValue(declarationName: ts.Identifier): boolean;
}

/** True when the compiler options tell TypeScript to stop eliding imports based on
 *  usage and keep everything but what's explicitly marked `type`. */
export function isErasureDisabledByFlag(options: ts.CompilerOptions): boolean {
  return (
    options.verbatimModuleSyntax === true ||
    options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Preserve ||
    options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Error ||
    options.preserveValueImports === true
  );
}

export function analyzeErasure(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  options: ts.CompilerOptions = {}
): ErasureAnalysis {
  const metadataRetainsTypes = options.emitDecoratorMetadata === true;
  const erasureDisabled = isErasureDisabledByFlag(options);
  // Symbols referenced from a value position somewhere in this file. Collected in
  // one walk so a file with many imports still costs a single traversal.
  const valueUsed = new Set<ts.Symbol>();

  const record = (symbol: ts.Symbol | undefined) => {
    if (symbol) valueUsed.add(symbol);
  };

  const visit = (node: ts.Node): void => {
    // `export { A }` with no module specifier re-exports a local binding: a real
    // value use, but the identifier resolves to the *export*, not to the import
    // it aliases, so getSymbolAtLocation would miss the link.
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
      if (!node.isTypeOnly && !node.parent.parent.isTypeOnly) {
        record(checker.getExportSpecifierLocalTargetSymbol(node));
      }
      return;
    }
    if (
      ts.isIdentifier(node) &&
      !isDeclarationName(node) &&
      (isValuePosition(node) || (metadataRetainsTypes && isDecoratorMetadataPosition(node)))
    ) {
      record(checker.getSymbolAtLocation(node));
    }
    ts.forEachChild(node, visit);
  };
  // The walk only feeds isUsedAsValue's heuristic; skip it when that heuristic is
  // disabled below, rather than paying for a traversal nothing will read.
  if (!erasureDisabled) ts.forEachChild(sourceFile, visit);

  return {
    isUsedAsValue(declarationName: ts.Identifier): boolean {
      if (erasureDisabled) return true; // compiler keeps it unless explicitly `type`
      const symbol = checker.getSymbolAtLocation(declarationName);
      return symbol ? valueUsed.has(symbol) : true; // unresolvable -> assume it runs
    },
  };
}

/** The `X` in `import { X }` / `class X {}` is a declaration, not a reference to one. */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node & { name?: ts.Node };
  return parent !== undefined && parent.name === node;
}

/**
 * Walk outward until something decides the position. Any enclosing TypeNode means
 * the identifier is erased with it; reaching the top without one means it is real
 * emitted code.
 */
function isValuePosition(node: ts.Identifier): boolean {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  while (parent) {
    // `typeof X` is a type query: erased, even though X names a value.
    if (ts.isTypeQueryNode(parent)) return false;
    // `class C extends B` is the one heritage position that emits a real
    // reference - B becomes the prototype. `implements I`, and an interface's
    // own `extends`, are erased. All three are ExpressionWithTypeArguments,
    // which `isTypeNode` reports as a type, so this has to be tested first.
    if (isClassExtendsExpression(parent, current)) return true;
    if (ts.isTypeNode(parent) || ts.isTypeParameterDeclaration(parent)) return false;
    current = parent;
    parent = parent.parent;
  }
  return true;
}

/**
 * Is this identifier inside a type annotation that `emitDecoratorMetadata` re-emits
 * as a runtime value? Climb to the annotation's owner, then ask whether that owner
 * (or, for a constructor parameter, its class) actually carries a decorator - an
 * undecorated declaration emits no metadata and its types still erase.
 */
function isDecoratorMetadataPosition(id: ts.Identifier): boolean {
  let current: ts.Node = id;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParameter(parent) && parent.type === current) {
      if (hasDecorator(parent)) return true; // a parameter decorator emits metadata too
      const owner = parent.parent;
      if (ts.isConstructorDeclaration(owner)) return hasDecorator(owner.parent);
      if (ts.isMethodDeclaration(owner) || ts.isSetAccessorDeclaration(owner)) return hasDecorator(owner);
      return false;
    }
    if (
      (ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent)) &&
      parent.type === current
    ) {
      return hasDecorator(parent);
    }
    current = parent;
  }
  return false;
}

function hasDecorator(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}

function isClassExtendsExpression(node: ts.Node, child: ts.Node): boolean {
  return (
    ts.isExpressionWithTypeArguments(node) &&
    node.expression === child &&
    node.parent !== undefined &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent))
  );
}

/**
 * `export { A } from './x'` names nothing locally, so there is no use to analyze -
 * what decides it is whether A is a value in the module it comes from. Same
 * verbatimModuleSyntax-family gate as analyzeErasure: under those flags the
 * re-export is kept regardless of A's meaning, unless explicitly marked `type`.
 */
export function reExportHasValueMeaning(
  specifier: ts.ExportSpecifier,
  checker: ts.TypeChecker,
  options: ts.CompilerOptions = {}
): boolean {
  if (isErasureDisabledByFlag(options)) return true;
  const local = checker.getSymbolAtLocation(specifier.name);
  if (!local) return true;
  let target = local;
  if (local.flags & ts.SymbolFlags.Alias) {
    try {
      target = checker.getAliasedSymbol(local);
    } catch {
      return true; // unresolvable alias -> assume it runs
    }
  }
  return (target.flags & ts.SymbolFlags.Value) !== 0;
}
