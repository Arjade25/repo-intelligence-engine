// `extends` on a class is the one heritage position that survives: Base becomes
// the prototype at runtime. `implements` is erased.
import { Base } from "./values";
import { Contract } from "./values";

export class Derived extends Base implements Contract {
  id = "1";
}
