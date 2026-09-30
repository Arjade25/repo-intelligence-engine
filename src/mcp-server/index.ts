#!/usr/bin/env node
/**
 * MCP server (plan §5): a THIN adapter. Every handler does two things — parse args
 * and call the matching engine/ function. No query logic lives here (step 5's
 * Done-when: MCP result === direct engine result). If you're tempted to add logic
 * in a handler, it belongs in engine/ instead.
 *
 * createServer() is exported (not just constructed at module load) so tests can
 * drive the real server over an InMemoryTransport-linked client, without spawning
 * a stdio subprocess — see mcp-server/index.test.ts.
 */
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { openDb } from "../storage/db.js";
import {
  findModule,
  findRelatedFiles,
  findSymbolReferences,
  dependencyPath,
  circularDependencyReport,
  findCycleThroughFile,
  reindex,
} from "../engine/index.js";
import { describeUnresolved } from "../indexer/resolution.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function createServer(db: Database.Database, tsconfigPath: string): McpServer {
  const server = new McpServer({ name: "repo-intelligence-engine", version: "0.1.0" });
  // Cycle tools report paths relative to the tsconfig's directory - the repo root an
  // agent works in - since absolute paths were most of their output's size.
  const root = dirname(resolve(tsconfigPath));

  server.tool(
    "find_module",
    "Locate which file(s) define a given symbol/class/function. Check symbol_indexed in the result: " +
      "false means no top-level declaration has that exact name (the note says what is indexed, and " +
      "similar_names lists case-insensitive matches), NOT that the name appears nowhere in the repo.",
    { name: z.string().describe("symbol name to locate") },
    async ({ name }) => json(findModule(db, name))
  );

  server.tool(
    "find_related_files",
    "What this file imports, and what imports it. Accepts absolute or repo-relative paths, " +
      "forward or back slashes, case-insensitive. Check file_indexed in the result: false means " +
      "the path matched no indexed file (the note says why), NOT that the file has no imports.",
    { file_path: z.string().describe("file path (absolute or repo-relative, any slash style)") },
    async ({ file_path }) => json(findRelatedFiles(db, file_path))
  );

  server.tool(
    "find_symbol_references",
    "Everywhere a symbol is used. Each reference includes the declaring file (declared_in) and kind, " +
      "since one name can match several distinct symbols; pass file_path to scope to one declaration. " +
      "Check symbol_indexed in the result: false means the name isn't in the index at all (e.g. class " +
      "methods are never indexed - only top-level declarations), NOT that it's unused. " +
      "re_exported_by lists barrel files that re-export the declaring module via `export * from`: those " +
      "never appear in references (a star re-export names no identifier for a reference search to match), " +
      "but are frequently a symbol's only use outside its own file.",
    {
      symbol: z.string().describe("symbol name"),
      file_path: z
        .string()
        .optional()
        .describe("only references to the declaration in this file (absolute or repo-relative, any slash style)"),
    },
    async ({ symbol, file_path }) => json(findSymbolReferences(db, symbol, file_path))
  );

  server.tool(
    "dependency_path",
    "Is there an import path from A to B, and what is it (shortest file chain, following static imports " +
      "and re-exports, including type-only ones). Each end may be a symbol name or a file path. If a symbol " +
      "name is declared in multiple files, the result's `ambiguity` field lists every candidate and which was used. " +
      "found:false with files_searched means the search was exhaustive over everything A imports - no need to verify by hand.",
    {
      symbol_a: z.string().describe("start: a symbol name or a file path"),
      symbol_b: z.string().describe("target: a symbol name or a file path"),
    },
    async ({ symbol_a, symbol_b }) => json(dependencyPath(db, symbol_a, symbol_b))
  );

  server.tool(
    "find_circular_dependencies",
    "Import cycles in the repo. Returns one entry per mutually-entangled group of files " +
      "(a strongly connected component) with its size and one example cycle, largest group first. " +
      "An empty groups array means the import graph is acyclic. Member lists are included for small " +
      "groups only (pass include_files for all). To ask whether a SPECIFIC file is in a cycle, or for a " +
      "loop through it, use find_cycle_through_file instead. " +
      "By default only RUNTIME cycles are reported: `import type` edges are erased by the " +
      "TypeScript compiler and cannot cause a runtime cycle. Pass include_type_only to see " +
      "source-level entanglement too - that number is usually much larger and is not a bug.",
    {
      include_type_only: z
        .boolean()
        .optional()
        .describe("count type-only imports as edges (default false)"),
      include_files: z
        .boolean()
        .optional()
        .describe("list every member of every group, not just small groups (default false)"),
    },
    async ({ include_type_only, include_files }) =>
      json(circularDependencyReport(db, { includeTypeOnly: include_type_only, includeFiles: include_files, root }))
  );

  server.tool(
    "find_cycle_through_file",
    "The shortest import cycle that starts and ends at this file, as an ordered file chain - or in_cycle:false " +
      "if none exists (the search is exhaustive; files_searched says how far it reached). Each entry in hops is " +
      "the evidence for one step: the statement's file:line and text, and runtime_names - the imported names " +
      "the type checker found used as values, so they survive compilation (a plain `import { A }` used only " +
      "as a type is erased even without the `type` keyword). Runtime imports only " +
      "by default: type-only imports are erased at compile time; when there is no runtime cycle, " +
      "type_only_cycle_exists says whether one appears once they are counted. Accepts absolute or " +
      "repo-relative paths, any slash style.",
    {
      file_path: z.string().describe("file path (absolute or repo-relative, any slash style)"),
      include_type_only: z
        .boolean()
        .optional()
        .describe("count type-only imports as edges (default false)"),
    },
    async ({ file_path, include_type_only }) =>
      json(findCycleThroughFile(db, file_path, { includeTypeOnly: include_type_only, root }))
  );

  server.tool(
    "reindex",
    "Rebuild the whole index for the repo (every file the tsconfig includes - there is no partial rebuild).",
    {},
    async () => {
      const { unresolved_internal_imports } = reindex(db, tsconfigPath);
      const { c } = db.prepare("SELECT COUNT(*) AS c FROM symbols").get() as { c: number };
      return json({
        ok: true,
        symbols: c,
        ...(unresolved_internal_imports.length > 0 && { warning: describeUnresolved(unresolved_internal_imports) }),
      });
    }
  );

  return server;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const DB_PATH = process.env.RIE_DB ?? "repo-index.db";
  const TSCONFIG = process.env.RIE_TSCONFIG ?? "./tsconfig.json";

  const db = openDb(DB_PATH);
  const server = createServer(db, TSCONFIG);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("repo-intelligence-engine MCP server running on stdio");
}
