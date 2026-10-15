import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function mod(name, deps) {
    const imports = deps.map((d) => `import { ${d} } from "./${d}.js";`);
    return [...imports, `export const ${name} = () => [${deps.join(", ")}];`, ""].join("\n");
}
export function modules(graph) {
    return Object.fromEntries(Object.entries(graph).map(([name, deps]) => [`${name}.ts`, mod(name, deps)]));
}
const s = (name) => `src/${name}.ts`;
const files = (...names) => names.map(s).sort();
const imp = (from, line, to) => ({
    at: `${s(from)}:${line}`,
    statement: `import { ${to} } from "./${to}.js";`,
});
/** a.ts that also exports a type, for the type-only traps. */
const aWithType = mod("a", ["b"]) + "export type A = { id: number };\n";
export const CYCLE_EVENT_CASES = [
    // --- the eight events ---------------------------------------------------------
    {
        name: "new_cycle",
        rule: "A cycle group appears whose files were in no cycle on base: fail",
        base: modules({ a: ["b"], b: ["c"], c: [] }),
        pr: modules({ a: ["b"], b: ["c"], c: ["a"] }),
        groups: { base: [], pr: [files("a", "b", "c")] },
        expected: {
            outcome: "fail",
            events: [
                {
                    type: "new_cycle",
                    outcome: "fail",
                    base_groups: [],
                    pr_groups: [files("a", "b", "c")],
                    joined: files("a", "b", "c"),
                    evidence: [{ loop: [s("c"), s("a"), s("b"), s("c")], hops: [imp("c", 1, "a"), imp("a", 1, "b"), imp("b", 1, "c")] }],
                },
            ],
        },
    },
    {
        name: "cycle_grown",
        rule: "An existing cycle group gains one or more files: fail",
        base: modules({ a: ["b"], b: ["c"], c: ["a"] }),
        pr: modules({ a: ["b"], b: ["c", "d"], c: ["a"], d: ["a"] }),
        groups: { base: [files("a", "b", "c")], pr: [files("a", "b", "c", "d")] },
        expected: {
            outcome: "fail",
            events: [
                {
                    type: "cycle_grown",
                    outcome: "fail",
                    base_groups: [files("a", "b", "c")],
                    pr_groups: [files("a", "b", "c", "d")],
                    joined: [s("d")],
                    // b -> d (b.ts:2) comes first; d -> a is on the same loop, so it adds nothing.
                    evidence: [{ loop: [s("b"), s("d"), s("a"), s("b")], hops: [imp("b", 2, "d"), imp("d", 1, "a"), imp("a", 1, "b")] }],
                },
            ],
        },
    },
    {
        name: "cycles_merged",
        rule: "Two or more separate groups on base become one group: fail",
        base: modules({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] }),
        pr: modules({ a: ["b"], b: ["a", "c"], c: ["d"], d: ["c", "a"] }),
        groups: { base: [files("a", "b"), files("c", "d")], pr: [files("a", "b", "c", "d")] },
        expected: {
            outcome: "fail",
            events: [
                {
                    type: "cycles_merged",
                    outcome: "fail",
                    base_groups: [files("a", "b"), files("c", "d")],
                    pr_groups: [files("a", "b", "c", "d")],
                    joined: [],
                    // b's and d's own shortest loops (b-a-b, d-c-d) stay inside their old groups;
                    // only a loop through a new edge shows the merge.
                    evidence: [
                        {
                            loop: [s("b"), s("c"), s("d"), s("a"), s("b")],
                            hops: [imp("b", 2, "c"), imp("c", 1, "d"), imp("d", 2, "a"), imp("a", 1, "b")],
                        },
                    ],
                },
            ],
        },
    },
    {
        name: "loop_shortened",
        rule: "No file joins or leaves a group, but a new edge inside it creates a shorter loop: warn",
        base: modules({ a: ["b"], b: ["c"], c: ["d"], d: ["a"] }),
        pr: modules({ a: ["b"], b: ["c"], c: ["d", "a"], d: ["a"] }),
        groups: { base: [files("a", "b", "c", "d")], pr: [files("a", "b", "c", "d")] },
        expected: {
            outcome: "warn",
            events: [
                {
                    type: "loop_shortened",
                    outcome: "warn",
                    base_groups: [files("a", "b", "c", "d")],
                    pr_groups: [files("a", "b", "c", "d")],
                    // d's shortest loop is still d-a-b-c-d.
                    shortened: [
                        { file: s("a"), base_length: 4, pr_length: 3 },
                        { file: s("b"), base_length: 4, pr_length: 3 },
                        { file: s("c"), base_length: 4, pr_length: 3 },
                    ],
                    evidence: [{ loop: [s("c"), s("a"), s("b"), s("c")], hops: [imp("c", 2, "a"), imp("a", 1, "b"), imp("b", 1, "c")] }],
                },
            ],
        },
    },
    {
        name: "cycle_split",
        rule: "One base group becomes two or more smaller groups, and no file joins: pass",
        base: modules({ a: ["b"], b: ["a", "c"], c: ["d"], d: ["c", "a"] }),
        pr: modules({ a: ["b"], b: ["a", "c"], c: ["d"], d: ["c"] }),
        groups: { base: [files("a", "b", "c", "d")], pr: [files("a", "b"), files("c", "d")] },
        expected: {
            outcome: "pass",
            events: [
                {
                    type: "cycle_split",
                    outcome: "pass",
                    base_groups: [files("a", "b", "c", "d")],
                    pr_groups: [files("a", "b"), files("c", "d")],
                },
            ],
        },
    },
    {
        name: "cycle_shrunk",
        rule: "Files leave a group that still exists: pass",
        base: modules({ a: ["b"], b: ["c"], c: ["a", "d"], d: ["a"] }),
        pr: modules({ a: ["b"], b: ["c"], c: ["a", "d"], d: [] }),
        groups: { base: [files("a", "b", "c", "d")], pr: [files("a", "b", "c")] },
        expected: {
            outcome: "pass",
            events: [
                {
                    type: "cycle_shrunk",
                    outcome: "pass",
                    base_groups: [files("a", "b", "c", "d")],
                    pr_groups: [files("a", "b", "c")],
                    left: [s("d")],
                },
            ],
        },
    },
    {
        name: "cycle_resolved",
        rule: "A group on base no longer exists: pass",
        base: modules({ a: ["b"], b: ["c"], c: ["a"] }),
        pr: modules({ a: ["b"], b: ["c"], c: [] }),
        groups: { base: [files("a", "b", "c")], pr: [] },
        expected: {
            outcome: "pass",
            events: [{ type: "cycle_resolved", outcome: "pass", base_groups: [files("a", "b", "c")], pr_groups: [], left: files("a", "b", "c") }],
        },
    },
    {
        name: "no_regression",
        rule: "No other event fired: pass (new imports that close no loop)",
        base: modules({ a: ["b"], b: ["c"], c: ["a"], e: ["f"], f: [] }),
        pr: modules({ a: ["b"], b: ["c"], c: ["a"], e: ["f", "g"], f: [], g: ["a"] }),
        groups: { base: [files("a", "b", "c")], pr: [files("a", "b", "c")] },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
    },
    // --- the rules every event follows --------------------------------------------
    {
        name: "type-only import (keyword) closes no loop",
        rule: "Runtime edges only: `import type` is erased",
        base: { ...modules({ b: ["c"], c: [] }), "a.ts": aWithType },
        pr: {
            ...modules({ b: ["c"] }),
            "a.ts": aWithType,
            "c.ts": 'import type { A } from "./a.js";\nexport const c = (x: A | null) => x;\n',
        },
        groups: { base: [], pr: [] },
        trap: { from: s("c"), to: s("a"), kind: "type" },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
    },
    {
        name: "type-only import (by usage) closes no loop",
        rule: "Runtime edges only: a plain import used only as a type is erased too",
        base: { ...modules({ b: ["c"], c: [] }), "a.ts": aWithType },
        pr: {
            ...modules({ b: ["c"] }),
            "a.ts": aWithType,
            "c.ts": 'import { A } from "./a.js";\nexport const c = (x: A | null) => x;\n',
        },
        groups: { base: [], pr: [] },
        trap: { from: s("c"), to: s("a"), kind: "type" },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
    },
    {
        name: "dynamic import() closes no loop",
        rule: "Runtime edges only: dynamic import() loads lazily, after the importer has loaded",
        base: modules({ a: ["b"], b: ["c"], c: [] }),
        pr: { ...modules({ a: ["b"], b: ["c"] }), "c.ts": 'export const c = () => import("./a.js");\n' },
        groups: { base: [], pr: [] },
        trap: { from: s("c"), to: s("a"), kind: "dynamic" },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
    },
    {
        name: "loop through a barrel re-export",
        rule: "Barrel re-exports count: loading a barrel runs every re-export",
        base: {
            ...modules({ b: ["c"], c: [] }),
            "a.ts": 'import { b } from "./index.js";\nexport const a = () => [b];\n',
            "index.ts": 'export * from "./b.js";\n',
        },
        pr: {
            ...modules({ b: ["c"], c: ["a"] }),
            "a.ts": 'import { b } from "./index.js";\nexport const a = () => [b];\n',
            "index.ts": 'export * from "./b.js";\n',
        },
        groups: { base: [], pr: [files("a", "b", "c", "index")] },
        expected: {
            outcome: "fail",
            events: [
                {
                    type: "new_cycle",
                    outcome: "fail",
                    base_groups: [],
                    pr_groups: [files("a", "b", "c", "index")],
                    joined: files("a", "b", "c", "index"),
                    evidence: [
                        {
                            loop: [s("c"), s("a"), s("index"), s("b"), s("c")],
                            hops: [
                                imp("c", 1, "a"),
                                { at: `${s("a")}:1`, statement: 'import { b } from "./index.js";' },
                                { at: `${s("index")}:1`, statement: 'export * from "./b.js";' },
                                imp("b", 1, "c"),
                            ],
                        },
                    ],
                },
            ],
        },
    },
    {
        name: "existing cycle touched but not worsened",
        rule: "Old cycles never fail a PR: the PR edits a group member and imports into the group",
        base: modules({ a: ["b"], b: ["c"], c: ["a"] }),
        pr: modules({ a: ["b"], b: ["c", "util"], c: ["a"], util: [], e: ["a"] }),
        groups: { base: [files("a", "b", "c")], pr: [files("a", "b", "c")] },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
    },
    {
        name: "file renamed inside a group",
        rule: "Groups are matched by shared files, after git's rename detection",
        base: modules({ a: ["b"], b: ["c"], c: ["a"] }),
        pr: modules({ a: ["b"], b: ["c2"], c2: ["a"] }),
        renames: { [s("c")]: s("c2") },
        groups: { base: [files("a", "b", "c")], pr: [files("a", "b", "c2")] },
        expected: { outcome: "pass", events: [{ type: "no_regression", outcome: "pass" }] },
        // Without the map, c2 reads as a file joining the group (and c as one leaving it).
        expected_without_renames: { outcome: "fail" },
    },
    {
        name: "several events, one fails",
        rule: "A PR that fires several events reports all of them; the outcome is the strictest",
        base: modules({ a: ["b"], b: ["a"], x: ["y"], y: [] }),
        pr: modules({ a: ["b"], b: [], x: ["y"], y: ["x"] }),
        groups: { base: [files("a", "b")], pr: [files("x", "y")] },
        expected: {
            outcome: "fail",
            events: [
                { type: "cycle_resolved", outcome: "pass", base_groups: [files("a", "b")], pr_groups: [], left: files("a", "b") },
                {
                    type: "new_cycle",
                    outcome: "fail",
                    base_groups: [],
                    pr_groups: [files("x", "y")],
                    joined: files("x", "y"),
                    evidence: [{ loop: [s("y"), s("x"), s("y")], hops: [imp("y", 1, "x"), imp("x", 1, "y")] }],
                },
            ],
        },
    },
    {
        name: "several events, one warns",
        rule: "Warn beats pass: one group resolved, another's loops shortened",
        base: modules({ a: ["b"], b: ["a"], c: ["d"], d: ["e"], e: ["f"], f: ["c"] }),
        pr: modules({ a: ["b"], b: [], c: ["d"], d: ["e"], e: ["f", "c"], f: ["c"] }),
        groups: { base: [files("a", "b"), files("c", "d", "e", "f")], pr: [files("c", "d", "e", "f")] },
        expected: {
            outcome: "warn",
            events: [
                { type: "cycle_resolved", outcome: "pass", base_groups: [files("a", "b")], pr_groups: [], left: files("a", "b") },
                {
                    type: "loop_shortened",
                    outcome: "warn",
                    base_groups: [files("c", "d", "e", "f")],
                    pr_groups: [files("c", "d", "e", "f")],
                    // f's shortest loop is still f-c-d-e-f.
                    shortened: [
                        { file: s("c"), base_length: 4, pr_length: 3 },
                        { file: s("d"), base_length: 4, pr_length: 3 },
                        { file: s("e"), base_length: 4, pr_length: 3 },
                    ],
                    evidence: [{ loop: [s("e"), s("c"), s("d"), s("e")], hops: [imp("e", 2, "c"), imp("c", 1, "d"), imp("d", 1, "e")] }],
                },
            ],
        },
    },
];
const TSCONFIG = {
    compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022"],
        rootDir: "./src",
        outDir: "./dist",
        strict: true,
        skipLibCheck: true,
    },
    include: ["src/**/*"],
};
/** Writes a snapshot as a small CommonJS repo; returns its tsconfig path. */
export function materialize(snapshot, label) {
    const root = mkdtempSync(join(tmpdir(), `rie-cycle-${label.replace(/\W+/g, "-")}-`));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cycle-fixture", type: "commonjs" }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2));
    for (const [path, content] of Object.entries(snapshot))
        writeFileSync(join(root, "src", path), content);
    return join(root, "tsconfig.json");
}
//# sourceMappingURL=cycle-events.cases.js.map