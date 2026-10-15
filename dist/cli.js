#!/usr/bin/env node
/**
 * The rie command: one entry point for the CLIs.
 *
 *   rie check ...    fail a PR that makes runtime import cycles worse (src/check/cli.ts)
 *   rie index ...    index a repo into a SQLite file (src/indexer/cli.ts)
 *   rie mcp          serve an index to coding agents over stdio (src/mcp-server)
 *   rie --version
 *
 * Each subcommand reads its own arguments from process.argv, so the subcommand's
 * name is taken out before it loads.
 */
import { readFileSync } from "node:fs";
const USAGE = `Usage: rie <command>

  rie check --pr=<tsconfig> --base-ref=<git ref>   compare a PR with its merge base
  rie check <tsconfig>                             list every runtime cycle group
  rie index <tsconfig> [output.db]                 index a repo
  rie mcp                                          serve the index over stdio (RIE_DB, RIE_TSCONFIG)
  rie --version`;
const [command] = process.argv.splice(2, 1);
switch (command) {
    case "check":
        await import("./check/cli.js");
        break;
    case "index":
        await import("./indexer/cli.js");
        break;
    case "mcp":
        await (await import("./mcp-server/index.js")).serveStdio();
        break;
    case "--version":
    case "-v":
        console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
        break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
        console.log(USAGE);
        break;
    default:
        console.error(`rie: unknown command "${command}"\n\n${USAGE}`);
        process.exit(2);
}
//# sourceMappingURL=cli.js.map