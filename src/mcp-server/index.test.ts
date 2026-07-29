import { describe, expect, it, beforeAll } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../storage/db.js";
import { reindex, findModule, findRelatedFiles, findSymbolReferences, dependencyPath } from "../engine/index.js";
import { createServer } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_TSCONFIG = join(__dirname, "../../fixtures/sample-repo/tsconfig.json");

/**
 * Calls an MCP tool through a real client<->server round trip and parses the JSON
 * text content back out (createServer's `json()` helper always wraps results this
 * way), so results can be compared directly against engine/ return values.
 */
async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0].text);
}

describe("mcp-server (thin adapter over engine/, plan step 5)", () => {
  const db = openDb(":memory:");
  reindex(db, FIXTURE_TSCONFIG);

  let client: Client;

  beforeAll(async () => {
    const server = createServer(db, FIXTURE_TSCONFIG);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  it("lists all five tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["dependency_path", "find_module", "find_related_files", "find_symbol_references", "reindex"].sort()
    );
  });

  it("find_module: MCP result matches the direct engine call", async () => {
    const viaMcp = await callToolJson(client, "find_module", { name: "Circle" });
    const direct = findModule(db, "Circle");
    expect(viaMcp).toEqual(direct);
    expect(direct.length).toBeGreaterThan(0); // sanity: not comparing two empty results
  });

  it("find_related_files: MCP result matches the direct engine call", async () => {
    const mainTs = findModule(db, "run")[0].file_path;
    const viaMcp = await callToolJson(client, "find_related_files", { file_path: mainTs });
    const direct = findRelatedFiles(db, mainTs);
    expect(viaMcp).toEqual(direct);
    expect(direct.imports.length).toBeGreaterThan(0);
  });

  it("find_symbol_references: MCP result matches the direct engine call", async () => {
    const viaMcp = await callToolJson(client, "find_symbol_references", { symbol: "Circle" });
    const direct = findSymbolReferences(db, "Circle");
    expect(viaMcp).toEqual(direct);
    expect(direct.length).toBeGreaterThan(0);
  });

  it("dependency_path: MCP result matches the direct engine call", async () => {
    const viaMcp = await callToolJson(client, "dependency_path", { symbol_a: "run", symbol_b: "add" });
    const direct = dependencyPath(db, "run", "add");
    expect(viaMcp).toEqual(direct);
    expect(direct.found).toBe(true);
  });

  it("reindex: MCP call rebuilds the index exactly like calling engine.reindex directly", async () => {
    const viaMcp = (await callToolJson(client, "reindex", {})) as { ok: boolean; symbols: number };
    expect(viaMcp.ok).toBe(true);

    const { c: directCount } = db.prepare("SELECT COUNT(*) AS c FROM symbols").get() as { c: number };
    expect(viaMcp.symbols).toBe(directCount);
    expect(directCount).toBe(6); // the fixture's hand-counted symbol total (step 1)
  });
});
