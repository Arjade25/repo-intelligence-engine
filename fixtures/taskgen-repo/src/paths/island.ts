// A near miss for "does start depend on island?": same directory, three importers,
// and island itself reaches start - but start never reaches island. Answer: no.
import { v0 } from "./start";

export const island = v0;
