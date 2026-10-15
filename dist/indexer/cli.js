#!/usr/bin/env tsx
/**
 * CLI entry for indexing a repo without MCP in the loop (plan §5: engine/ and the
 * indexer must be usable directly). Usage:
 *   npm run index -- <path-to-tsconfig.json> [output.db]
 */
import { openDb } from "../storage/db.js";
import { reindex } from "../engine/index.js";
import { describeUnresolved } from "./resolution.js";
const tsconfigPath = process.argv[2];
const dbPath = process.argv[3] ?? "repo-index.db";
if (!tsconfigPath) {
    console.error("usage: npm run index -- <path-to-tsconfig.json> [output.db]");
    process.exit(1);
}
const db = openDb(dbPath);
const started = Date.now();
const { unresolved_internal_imports, config_errors } = reindex(db, tsconfigPath);
const { symbols } = db.prepare("SELECT COUNT(*) AS symbols FROM symbols").get();
const { edges } = db.prepare("SELECT COUNT(*) AS edges FROM edges").get();
const { refs } = db.prepare("SELECT COUNT(*) AS refs FROM references_").get();
console.error(`indexed ${symbols} symbols, ${edges} edges, ${refs} references in ${Date.now() - started}ms -> ${dbPath}`);
if (config_errors.length > 0) {
    const hint = config_errors.some((e) => /not found/i.test(e)) ? " (are the dependencies installed?)" : "";
    console.error(`WARNING: ${config_errors.length} error(s) in the tsconfig, so its compiler options may be incomplete${hint}:\n  ${config_errors.join("\n  ")}`);
}
if (unresolved_internal_imports.length > 0)
    console.error(`WARNING: ${describeUnresolved(unresolved_internal_imports)}`);
db.close();
//# sourceMappingURL=cli.js.map