#!/usr/bin/env node
/**
 * MCP server (plan §5): a THIN adapter. Every handler does two things — parse args
 * and call the matching engine/ function. No query logic lives here (step 5's
 * Done-when: MCP result === direct engine result). If you're tempted to add logic
 * in a handler, it belongs in engine/ instead.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "../storage/db.js";
import { indexRepository } from "../indexer/index.js";
import {
  findModule,
  findRelatedFiles,
  findSymbolReferences,
  dependencyPath,
} from "../engine/index.js";

const DB_PATH = process.env.RIE_DB ?? "repo-index.db";
const TSCONFIG = process.env.RIE_TSCONFIG ?? "./tsconfig.json";

const db = openDb(DB_PATH);
const server = new McpServer({ name: "repo-intelligence-engine", version: "0.1.0" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

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
  "Everywhere a symbol is used.",
  { symbol: z.string().describe("symbol name") },
  async ({ symbol }) => json(findSymbolReferences(db, symbol))
);

server.tool(
  "dependency_path",
  "Is there an import path between two symbols, and what is it (file chain).",
  { symbol_a: z.string(), symbol_b: z.string() },
  async ({ symbol_a, symbol_b }) => json(dependencyPath(db, symbol_a, symbol_b))
);

server.tool(
  "reindex",
  "Rebuild the index for the repo (uses RIE_TSCONFIG).",
  { path: z.string().optional().describe("optional subtree; v1 rebuilds all") },
  async () => {
    indexRepository(db, TSCONFIG);
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM symbols").get() as { c: number };
    return json({ ok: true, symbols: c });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("repo-intelligence-engine MCP server running on stdio");
