// Dep's only use is a shorthand property: `{ Dep }` is `{ Dep: Dep }`, a value
// reference. The identifier is also the property's name, which made it look like
// a declaration. Found in immich (`{ extraModels }` in a Swagger options object).
import { Dep } from "./deps.js";

export const registry = { Dep };
