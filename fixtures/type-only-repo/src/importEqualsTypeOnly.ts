// Same import-equals form as importEquals.ts, but the binding is only ever
// referenced from a type position - emit-verified to disappear from compiled
// output entirely (checked against a real tsc emit before this fixture was
// written), same as a plain named import used the same way.
import contractNs = require("./values");

export interface UsesImportEqualsAsType {
  c: contractNs.Contract;
}
