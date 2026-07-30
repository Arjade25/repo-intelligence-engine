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
  reindex,
} from "../engine/index.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function createServer(db: Database.Database, tsconfigPath: string): McpServer {
  const server = new McpServer({ name: "repo-intelligence-engine", version: "0.1.0" });

  server.tool(
    "find_module",
    "Locate which file(s) define a given symbol/class/function.",
    { name: z.string().describe("symbol name to locate") },
    async ({ name }) => json(findModule(db, name))
  );

  server.tool(
    "find_related_files",
    "What this file imports, and what imports it.",
    { file_path: z.string().describe("absolute file path") },
    async ({ file_path }) => json(findRelatedFiles(db, file_path))
  );

  server.tool(
    "find_symbol_references",
    "Everywhere a symbol is used. Each reference includes the declaring file (declared_in) and kind, " +
      "since one name can match several distinct symbols; pass file_path to scope to one declaration. " +
      "Check symbol_indexed in the result: false means the name isn't in the index at all (e.g. class " +
      "methods are never indexed - only top-level declarations), NOT that it's unused.",
    {
      symbol: z.string().describe("symbol name"),
      file_path: z.string().optional().describe("only references to the declaration in this file"),
    },
    async ({ symbol, file_path }) => json(findSymbolReferences(db, symbol, file_path))
  );

  server.tool(
    "dependency_path",
    "Is there an import path between two symbols, and what is it (file chain). If a symbol name is " +
      "declared in multiple files, the result's `ambiguity` field lists every candidate and which was used.",
    { symbol_a: z.string(), symbol_b: z.string() },
    async ({ symbol_a, symbol_b }) => json(dependencyPath(db, symbol_a, symbol_b))
  );

  server.tool(
    "reindex",
    "Rebuild the index for the repo.",
    { path: z.string().optional().describe("optional subtree; v1 rebuilds all") },
    async () => {
      reindex(db, tsconfigPath);
      const { c } = db.prepare("SELECT COUNT(*) AS c FROM symbols").get() as { c: number };
      return json({ ok: true, symbols: c });
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
