#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
export declare function createServer(db: Database.Database, tsconfigPath: string): McpServer;
/** Serve the index over stdio: RIE_DB (default repo-index.db) for the index, RIE_TSCONFIG (default ./tsconfig.json) for reindex. */
export declare function serveStdio(): Promise<void>;
