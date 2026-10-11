// Only an inline `type` name - under verbatimModuleSyntax the statement is still
// emitted as `import {} from "./values.js"`, which loads the module.
import { type Contract } from "./values.js";

export interface UsesContract {
  c: Contract;
}
