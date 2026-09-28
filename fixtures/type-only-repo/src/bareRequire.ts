// A bare `require()` call - an ordinary CallExpression, not an import declaration.
// This is TypeORM's src/cli-ts-node-esm.ts shape (`require("./cli")` inside an
// `if`), which extractEdges once missed entirely: it walked import/export/
// import-equals statements only, while the compiled output keeps the require().
// Top-level (not inside any function), so it runs when this module loads.
if (process.env.RIE_FIXTURE_NEVER_SET) {
  require("./values");
}

export const loadedBareRequire = true;
