// `import x = require(...)` is a distinct AST node (ImportEqualsDeclaration) from
// `import { x } from "..."` (ImportDeclaration) - worth its own fixture since it
// went entirely unwalked by extractEdges until this was added: every such
// statement produced zero edges, runtime or not.
import widgetNs = require("./values");

export const kind = new widgetNs.Widget().kind;
