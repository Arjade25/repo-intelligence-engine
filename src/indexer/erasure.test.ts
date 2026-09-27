import { describe, expect, it } from "vitest";
import ts from "typescript";
import { isErasureDisabledByFlag } from "./erasure.js";

/**
 * `isErasureDisabledByFlag` is the shared gate behind verbatimModuleSyntax and its
 * two deprecated predecessors (importsNotUsedAsValues, preserveValueImports) - see
 * the module doc comment in erasure.ts. It's a pure function over CompilerOptions,
 * so it's worth its own direct coverage of every flag/value combination rather than
 * standing up a ts.Program per case; the end-to-end effect on real edges is covered
 * separately by the verbatim-module-syntax-repo fixture in index.test.ts.
 */
describe("isErasureDisabledByFlag", () => {
  it("is off by default (no flags set)", () => {
    expect(isErasureDisabledByFlag({})).toBe(false);
  });

  it("is on when verbatimModuleSyntax is true", () => {
    expect(isErasureDisabledByFlag({ verbatimModuleSyntax: true })).toBe(true);
  });

  it("is off when verbatimModuleSyntax is explicitly false", () => {
    expect(isErasureDisabledByFlag({ verbatimModuleSyntax: false })).toBe(false);
  });

  it("is on for the deprecated importsNotUsedAsValues: preserve", () => {
    expect(isErasureDisabledByFlag({ importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Preserve })).toBe(true);
  });

  it("is on for the deprecated importsNotUsedAsValues: error", () => {
    expect(isErasureDisabledByFlag({ importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Error })).toBe(true);
  });

  it("is off for importsNotUsedAsValues: remove (the default value)", () => {
    expect(isErasureDisabledByFlag({ importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove })).toBe(false);
  });

  it("is on for the deprecated preserveValueImports", () => {
    expect(isErasureDisabledByFlag({ preserveValueImports: true })).toBe(true);
  });

  it("is off when preserveValueImports is explicitly false", () => {
    expect(isErasureDisabledByFlag({ preserveValueImports: false })).toBe(false);
  });
});
