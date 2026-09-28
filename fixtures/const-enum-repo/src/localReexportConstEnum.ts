// `export { Color }` of an imported const enum, with no module specifier. The
// compiler keeps the import only when it also keeps the const enum object
// (preserveConstEnums or isolatedModules); otherwise both vanish.
import { Color } from "./enums.js";

export { Color };
