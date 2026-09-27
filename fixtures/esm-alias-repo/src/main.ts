// The package is "type": "module", so under Node16 these resolve in ESM mode.
import { answer } from "@dir"; // directory alias: never resolves in ESM mode
import { answer as same } from "@file"; // file alias: resolves
import { gone } from "./missing.js"; // relative, genuinely missing
import { readFileSync } from "node:fs"; // external: not our business

export const total = answer + same + gone + readFileSync.length;
