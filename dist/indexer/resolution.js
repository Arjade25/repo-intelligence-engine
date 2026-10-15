import ts from "typescript";
import { findTopLevelRequireCalls, normalizePath } from "./index.js";
export function findUnresolvedInternalImports(program, options = program.getCompilerOptions()) {
    const host = ts.createCompilerHost(options);
    const aliasPatterns = Object.keys(options.paths ?? {}).map((key) => {
        const star = key.indexOf("*");
        return star === -1 ? { prefix: key, suffix: "", exact: true } : { prefix: key.slice(0, star), suffix: key.slice(star + 1), exact: false };
    });
    // Bundler asset imports (`./logo.svg`, `./icon.svg?react`, `./x.css`) aren't
    // modules the compiler resolves, and can't sit on an import cycle. Flagging them
    // blocked element-web, which has 51 of them. Any `?query` specifier is a bundler
    // loader (`./exportJS.js?raw` loads the file as text), never a module import.
    const isAsset = (spec) => spec.includes("?") ||
        /\.(svg|png|jpe?g|gif|webp|avif|ico|css|pcss|postcss|scss|sass|less|woff2?|ttf|otf|eot|mp3|mp4|ogg|wav|webm|wasm|html|txt|md|vert|frag|glsl|wgsl)$/i.test(spec.replace(/[?#].*$/, ""));
    const isInternal = (spec) => !isAsset(spec) &&
        (spec.startsWith(".") ||
            aliasPatterns.some((p) => p.exact ? spec === p.prefix : spec.length >= p.prefix.length + p.suffix.length && spec.startsWith(p.prefix) && spec.endsWith(p.suffix)));
    const out = [];
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile || program.isSourceFileFromExternalLibrary(sf))
            continue;
        // A bare require() always resolves in CJS mode, whatever the file's own mode.
        const specs = [
            ...moduleSpecifiers(sf).map((spec) => ({ spec, mode: ts.getModeForUsageLocation(sf, spec, options) })),
            ...findTopLevelRequireCalls(sf).map((spec) => ({ spec, mode: ts.ModuleKind.CommonJS })),
        ];
        for (const { spec, mode } of specs) {
            if (!isInternal(spec.text))
                continue;
            const resolved = ts.resolveModuleName(spec.text, sf.fileName, options, host, undefined, undefined, mode);
            if (resolved.resolvedModule)
                continue;
            out.push({
                file: normalizePath(sf.fileName),
                line: sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1,
                specifier: spec.text,
            });
        }
    }
    return out;
}
/** One-line summary plus a few examples, for CLI output and tool results. */
export function describeUnresolved(unresolved, max = 5) {
    const examples = unresolved.slice(0, max).map((u) => `  ${u.file}:${u.line}  '${u.specifier}'`);
    const more = unresolved.length > max ? [`  ... and ${unresolved.length - max} more`] : [];
    return [
        `${unresolved.length} internal import(s) do not resolve under the compiler's own module resolution. ` +
            `References and type-check results through them are wrong, and edges may be missing. Check the tsconfig's paths/moduleResolution.`,
        ...examples,
        ...more,
    ].join("\n");
}
function moduleSpecifiers(sf) {
    const out = [];
    for (const stmt of sf.statements) {
        if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            out.push(stmt.moduleSpecifier);
        }
        else if (ts.isImportEqualsDeclaration(stmt) &&
            ts.isExternalModuleReference(stmt.moduleReference) &&
            ts.isStringLiteral(stmt.moduleReference.expression)) {
            out.push(stmt.moduleReference.expression);
        }
    }
    return out;
}
//# sourceMappingURL=resolution.js.map