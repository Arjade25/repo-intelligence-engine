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
 * when the option is on - but only the one name the compiler serializes, and only
 * when it names a value (see metadataEntityName).
 *
 * A `const enum` is inlined, so its import vanishes from the emitted JS even though
 * the source uses it as a value - most of nest's 29 safe-direction over-reports.
 * The rule mirrors the checker's own (markAliasReferenced / isAliasResolvedToValue)
 * and was checked against real emit under each flag (fixtures/const-enum-repo):
 *   - a value use keeps the import only under `isolatedModules`
 *   - an export (`export { E }`, `export { E } from`) keeps it under
 *     `isolatedModules` or `preserveConstEnums`
 * Only a symbol that IS a const enum counts; a namespace holding only const enums
 * (which the compiler also inlines) is still treated as a value - the safe direction.
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
  const strictNullChecks = options.strictNullChecks ?? options.strict ?? false;
  const erasureDisabled = isErasureDisabledByFlag(options);
  // Symbols referenced from a value position somewhere in this file. Collected in
  // one walk so a file with many imports still costs a single traversal.
  const valueUsed = new Set<ts.Symbol>();

  const record = (symbol: ts.Symbol | undefined, keepsConstEnum: boolean) => {
    if (!symbol) return;
    if (!keepsConstEnum && isConstEnumAlias(symbol, checker)) return; // inlined, import dropped
    valueUsed.add(symbol);
  };

  const visit = (node: ts.Node): void => {
    // `export { A }` with no module specifier re-exports a local binding: a real
    // value use, but the identifier resolves to the *export*, not to the import
    // it aliases, so getSymbolAtLocation would miss the link.
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
      if (!node.isTypeOnly && !node.parent.parent.isTypeOnly) {
        record(checker.getExportSpecifierLocalTargetSymbol(node), preservesConstEnums(options));
      }
      return;
    }
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      if (isValuePosition(node)) {
        record(checker.getSymbolAtLocation(node), options.isolatedModules === true);
      } else if (metadataRetainsTypes && isDecoratorMetadataPosition(node, strictNullChecks)) {
        // Metadata re-emits the type as a value reference only if the name IS a
        // value (a class); an interface or type alias serializes as `Object` and
        // its import is still dropped.
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol && resolvesToValue(symbol, checker)) record(symbol, options.isolatedModules === true);
      }
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

/**
 * Anything inside a `declare` context (e.g. `declare class X extends Base`, or a
 * `declare namespace`/`declare module` body) emits no code at all.
 */
function isInAmbientContext(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** The compiler keeps const enum objects (and exports of them) under either flag. */
function preservesConstEnums(options: ts.CompilerOptions): boolean {
  return options.preserveConstEnums === true || options.isolatedModules === true;
}

/** Is this an import binding (alias) whose target is a const enum? */
function isConstEnumAlias(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return false;
  try {
    return (checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.ConstEnum) !== 0;
  } catch {
    return false; // unresolvable alias -> assume it runs
  }
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
  if (isInAmbientContext(node)) return false;
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
 * Is this identifier the name `emitDecoratorMetadata` re-emits as a runtime value?
 * Climb to the type annotation's owner, then ask whether that owner (or, for a
 * constructor parameter, its class) actually carries a decorator - an undecorated
 * declaration emits no metadata and its types still erase. Within a decorated
 * annotation, only the root of the one entity name the compiler serializes counts
 * (see metadataEntityName): `Dep` in `Promise<Dep>` or `Dep | Other` is erased.
 */
function isDecoratorMetadataPosition(id: ts.Identifier, strictNullChecks: boolean): boolean {
  let current: ts.Node = id;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParameter(parent) && parent.type === current) {
      if (!isMetadataRoot(id, parent.type, strictNullChecks)) return false;
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
      return isMetadataRoot(id, parent.type, strictNullChecks) && hasDecorator(parent);
    }
    current = parent;
  }
  return false;
}

/** Is `id` the leftmost identifier of the entity name the compiler serializes for `type`? */
function isMetadataRoot(id: ts.Identifier, type: ts.TypeNode, strictNullChecks: boolean): boolean {
  let name = metadataEntityName(type, strictNullChecks);
  while (name && ts.isQualifiedName(name)) name = name.left;
  return name === id;
}

/**
 * The single entity name `emitDecoratorMetadata` serializes for a type annotation,
 * mirroring the checker's getEntityNameForDecoratorMetadata: a type reference's own
 * name (never its type arguments), unwrapped through parentheses, and a union,
 * intersection or conditional only when every member names the same identifier -
 * skipping `never`, plus null/undefined when strictNullChecks is off. Anything else
 * serializes to a global (`Object`, `Number`, ...) and references no import.
 */
function metadataEntityName(node: ts.TypeNode, strictNullChecks: boolean): ts.EntityName | undefined {
  if (ts.isParenthesizedTypeNode(node)) return metadataEntityName(node.type, strictNullChecks);
  if (ts.isTypeReferenceNode(node)) return node.typeName;
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return commonEntityName(node.types, strictNullChecks);
  if (ts.isConditionalTypeNode(node)) return commonEntityName([node.trueType, node.falseType], strictNullChecks);
  return undefined;
}

function commonEntityName(types: readonly ts.TypeNode[], strictNullChecks: boolean): ts.EntityName | undefined {
  let common: ts.EntityName | undefined;
  for (let t of types) {
    while (ts.isParenthesizedTypeNode(t)) t = t.type;
    if (t.kind === ts.SyntaxKind.NeverKeyword) continue;
    if (
      !strictNullChecks &&
      (t.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword))
    ) {
      continue;
    }
    const name = metadataEntityName(t, strictNullChecks);
    if (!name) return undefined;
    if (common) {
      // Only two plain identifiers with the same text agree; qualified names never do.
      if (!ts.isIdentifier(common) || !ts.isIdentifier(name) || common.text !== name.text) return undefined;
    } else {
      common = name;
    }
  }
  return common;
}

/** Does this symbol (following an import alias) name a value, not just a type? */
function resolvesToValue(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  let target = symbol;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      target = checker.getAliasedSymbol(symbol);
    } catch {
      return true; // unresolvable alias -> assume it runs
    }
  }
  return (target.flags & ts.SymbolFlags.Value) !== 0;
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
  if (target.flags & ts.SymbolFlags.ConstEnum) return preservesConstEnums(options);
  return (target.flags & ts.SymbolFlags.Value) !== 0;
}
