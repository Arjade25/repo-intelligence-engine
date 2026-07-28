#!/usr/bin/env tsx
/**
 * CLI entry for indexing a repo without MCP in the loop (plan §5: engine/ and the
 * indexer must be usable directly). Usage:
 *   npm run index -- <path-to-tsconfig.json> [output.db]
 */
import { openDb } from "../storage/db.js";
import { indexRepository } from "./index.js";

const tsconfigPath = process.argv[2];
const dbPath = process.argv[3] ?? "repo-index.db";

if (!tsconfigPath) {
  console.error("usage: npm run index -- <path-to-tsconfig.json> [output.db]");
  process.exit(1);
}

const db = openDb(dbPath);
const started = Date.now();
indexRepository(db, tsconfigPath);

const { symbols } = db.prepare("SELECT COUNT(*) AS symbols FROM symbols").get() as { symbols: number };
const { edges } = db.prepare("SELECT COUNT(*) AS edges FROM edges").get() as { edges: number };
console.error(`indexed ${symbols} symbols, ${edges} edges in ${Date.now() - started}ms -> ${dbPath}`);
db.close();
