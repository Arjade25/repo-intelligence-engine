import ts from "typescript";
/** True when the compiler options tell TypeScript to stop eliding imports based on
 *  usage and keep everything but what's explicitly marked `type`. */
export function isErasureDisabledByFlag(options) {
    return (options.verbatimModuleSyntax === true ||
        options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Preserve ||
        options.importsNotUsedAsValues === ts.ImportsNotUsedAsValues.Error ||
        options.preserveValueImports === true);
}
export function analyzeErasure(sourceFile, checker, options = {}) {
    const metadataRetainsTypes = options.emitDecoratorMetadata === true;
    const strictNullChecks = options.strictNullChecks ?? options.strict ?? false;
    const erasureDisabled = isErasureDisabledByFlag(options);
    // Symbols referenced from a value position somewhere in this file. Collected in
    // one walk so a file with many imports still costs a single traversal.
    const valueUsed = new Set();
    const record = (symbol, keepsConstEnum) => {
        if (!symbol)
            return;
        if (!keepsConstEnum && isConstEnumAlias(symbol, checker))
            return; // inlined, import dropped
        valueUsed.add(symbol);
    };
    const visit = (node) => {
        // `export { A }` with no module specifier re-exports a local binding: a real
        // value use, but the identifier resolves to the *export*, not to the import
        // it aliases, so getSymbolAtLocation would miss the link.
        if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
            if (!node.isTypeOnly && !node.parent.parent.isTypeOnly) {
                record(checker.getExportSpecifierLocalTargetSymbol(node), preservesConstEnums(options));
            }
            return;
        }
        // `{ X }` is `{ X: X }`: the identifier is the property's name AND a reference to
        // the binding X, so isDeclarationName would skip it, and getSymbolAtLocation would
        // return the property. Found by the oracle on immich (`{ extraModels }`).
        if (ts.isShorthandPropertyAssignment(node)) {
            if (isValuePosition(node.name))
                record(checker.getShorthandAssignmentValueSymbol(node), options.isolatedModules === true);
            if (node.objectAssignmentInitializer)
                visit(node.objectAssignmentInitializer);
            return;
        }
        if (ts.isIdentifier(node) && !isDeclarationName(node)) {
            if (isValuePosition(node)) {
                record(checker.getSymbolAtLocation(node), options.isolatedModules === true);
            }
            else if (metadataRetainsTypes && isDecoratorMetadataPosition(node, strictNullChecks)) {
                // Metadata re-emits the type as a value reference only if the name IS a
                // value (a class); an interface or type alias serializes as `Object` and
                // its import is still dropped.
                const symbol = checker.getSymbolAtLocation(node);
                if (symbol && resolvesToValue(symbol, checker))
                    record(symbol, options.isolatedModules === true);
            }
        }
        ts.forEachChild(node, visit);
    };
    // The walk only feeds isUsedAsValue's heuristic; skip it when that heuristic is
    // disabled below, rather than paying for a traversal nothing will read.
    if (!erasureDisabled)
        ts.forEachChild(sourceFile, visit);
    return {
        isUsedAsValue(declarationName) {
            if (erasureDisabled)
                return true; // compiler keeps it unless explicitly `type`
            const symbol = checker.getSymbolAtLocation(declarationName);
            return symbol ? valueUsed.has(symbol) : true; // unresolvable -> assume it runs
        },
    };
}
/**
 * Anything inside a `declare` context (e.g. `declare class X extends Base`, or a
 * `declare namespace`/`declare module` body) emits no code at all.
 */
function isInAmbientContext(node) {
    for (let n = node; n; n = n.parent) {
        if (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword))
            return true;
    }
    return false;
}
/** The compiler keeps const enum objects (and exports of them) under either flag. */
function preservesConstEnums(options) {
    return options.preserveConstEnums === true || options.isolatedModules === true;
}
/** Is this an import binding (alias) whose target is a const enum? */
function isConstEnumAlias(symbol, checker) {
    if (!(symbol.flags & ts.SymbolFlags.Alias))
        return false;
    try {
        return (checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.ConstEnum) !== 0;
    }
    catch {
        return false; // unresolvable alias -> assume it runs
    }
}
/** The `X` in `import { X }` / `class X {}` is a declaration, not a reference to one. */
function isDeclarationName(node) {
    const parent = node.parent;
    return parent !== undefined && parent.name === node;
}
/**
 * Walk outward until something decides the position. Any enclosing TypeNode means
 * the identifier is erased with it; reaching the top without one means it is real
 * emitted code.
 */
function isValuePosition(node) {
    if (isInAmbientContext(node))
        return false;
    let current = node;
    let parent = node.parent;
    while (parent) {
        // `typeof X` is a type query: erased, even though X names a value.
        if (ts.isTypeQueryNode(parent))
            return false;
        // `class C extends B` is the one heritage position that emits a real
        // reference - B becomes the prototype. `implements I`, and an interface's
        // own `extends`, are erased. All three are ExpressionWithTypeArguments,
        // which `isTypeNode` reports as a type, so this has to be tested first.
        if (isClassExtendsExpression(parent, current))
            return true;
        // An instantiation expression (`Dialog<Props>` passed as a value, TS 4.7+) is
        // the same node kind outside any heritage clause: the expression is emitted,
        // only the type arguments erase. Found by the oracle on element-web, where a
        // default import used only this way was reported as erased.
        if (isInstantiationExpression(parent, current)) {
            current = parent;
            parent = parent.parent;
            continue;
        }
        if (ts.isTypeNode(parent) || ts.isTypeParameterDeclaration(parent))
            return false;
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
function isDecoratorMetadataPosition(id, strictNullChecks) {
    let current = id;
    while (current.parent) {
        const parent = current.parent;
        if (ts.isParameter(parent) && parent.type === current) {
            if (!isMetadataRoot(id, parent.type, strictNullChecks))
                return false;
            // One decorated parameter is enough for `design:paramtypes` to list every
            // parameter's type, whether or not the class (or method) is decorated. Found by
            // the oracle on immich, whose NestJS BaseModule has only `@Inject(IWorker)`.
            const owner = parent.parent;
            const anyParameterDecorated = ts.isFunctionLike(owner) && owner.parameters.some(hasDecorator);
            if (ts.isConstructorDeclaration(owner))
                return anyParameterDecorated || hasDecorator(owner.parent);
            if (ts.isMethodDeclaration(owner) || ts.isSetAccessorDeclaration(owner))
                return anyParameterDecorated || hasDecorator(owner);
            return false;
        }
        if ((ts.isPropertyDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent)) &&
            parent.type === current) {
            return isMetadataRoot(id, parent.type, strictNullChecks) && hasDecorator(parent);
        }
        current = parent;
    }
    return false;
}
/** Is `id` the leftmost identifier of the entity name the compiler serializes for `type`? */
function isMetadataRoot(id, type, strictNullChecks) {
    let name = metadataEntityName(type, strictNullChecks);
    while (name && ts.isQualifiedName(name))
        name = name.left;
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
function metadataEntityName(node, strictNullChecks) {
    if (ts.isParenthesizedTypeNode(node))
        return metadataEntityName(node.type, strictNullChecks);
    if (ts.isTypeReferenceNode(node))
        return node.typeName;
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))
        return commonEntityName(node.types, strictNullChecks);
    if (ts.isConditionalTypeNode(node))
        return commonEntityName([node.trueType, node.falseType], strictNullChecks);
    return undefined;
}
function commonEntityName(types, strictNullChecks) {
    let common;
    for (let t of types) {
        while (ts.isParenthesizedTypeNode(t))
            t = t.type;
        if (t.kind === ts.SyntaxKind.NeverKeyword)
            continue;
        if (!strictNullChecks &&
            (t.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword))) {
            continue;
        }
        const name = metadataEntityName(t, strictNullChecks);
        if (!name)
            return undefined;
        if (common) {
            // Only two plain identifiers with the same text agree; qualified names never do.
            if (!ts.isIdentifier(common) || !ts.isIdentifier(name) || common.text !== name.text)
                return undefined;
        }
        else {
            common = name;
        }
    }
    return common;
}
/** Does this symbol (following an import alias) name a value, not just a type? */
function resolvesToValue(symbol, checker) {
    let target = symbol;
    if (symbol.flags & ts.SymbolFlags.Alias) {
        try {
            target = checker.getAliasedSymbol(symbol);
        }
        catch {
            return true; // unresolvable alias -> assume it runs
        }
    }
    return (target.flags & ts.SymbolFlags.Value) !== 0;
}
function hasDecorator(node) {
    return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}
function isInstantiationExpression(node, child) {
    return (ts.isExpressionWithTypeArguments(node) &&
        node.expression === child &&
        (node.parent === undefined || !ts.isHeritageClause(node.parent)));
}
function isClassExtendsExpression(node, child) {
    return (ts.isExpressionWithTypeArguments(node) &&
        node.expression === child &&
        node.parent !== undefined &&
        ts.isHeritageClause(node.parent) &&
        node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(node.parent.parent) || ts.isClassExpression(node.parent.parent)));
}
/**
 * `export { A } from './x'` names nothing locally, so there is no use to analyze -
 * what decides it is whether A is a value in the module it comes from. Same
 * verbatimModuleSyntax-family gate as analyzeErasure: under those flags the
 * re-export is kept regardless of A's meaning, unless explicitly marked `type`.
 */
export function reExportHasValueMeaning(specifier, checker, options = {}) {
    if (isErasureDisabledByFlag(options))
        return true;
    const local = checker.getSymbolAtLocation(specifier.name);
    if (!local)
        return true;
    let target = local;
    if (local.flags & ts.SymbolFlags.Alias) {
        try {
            target = checker.getAliasedSymbol(local);
        }
        catch {
            return true; // unresolvable alias -> assume it runs
        }
    }
    if (target.flags & ts.SymbolFlags.ConstEnum)
        return preservesConstEnums(options);
    return (target.flags & ts.SymbolFlags.Value) !== 0;
}
//# sourceMappingURL=erasure.js.map