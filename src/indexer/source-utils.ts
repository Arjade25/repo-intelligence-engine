import ts from "typescript";

/** Normalize path separators so from_file/to_file join cleanly across platforms. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Every `require("literal")` call that runs when the module loads - i.e. not
 * nested inside a function, method, accessor, constructor or static block. A
 * require() inside a function is a lazy load: it can't take part in an
 * initialization cycle, and counting it would also turn every downleveled dynamic
 * `import()` (`Promise.resolve().then(() => require(X))`) into a hard edge. This is
 * the same boundary rule benchmarks/oracle/emitted-edges.ts applies to emitted
 * JS; the two are kept separate on purpose so the oracle can catch bugs here.
 */
export function findTopLevelRequireCalls(sourceFile: ts.SourceFile): ts.StringLiteral[] {
  const out: ts.StringLiteral[] = [];

  const isFunctionBoundary = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node);

  const visit = (node: ts.Node): void => {
    if (isFunctionBoundary(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return out;
}
