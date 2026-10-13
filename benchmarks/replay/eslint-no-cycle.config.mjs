// eslint-plugin-import's import/no-cycle as a team would turn it on for TypeScript:
// the typescript-eslint parser, the TypeScript resolver on the snapshot's tsconfig,
// and the rule's defaults (no depth limit; dynamic import() counts; `import type`
// doesn't). Used by eslintGraph in graphs.ts, which sets RIE_ESLINT_TSCONFIG.
import importPlugin from "eslint-plugin-import";
import tsParser from "@typescript-eslint/parser";

const project = process.env.RIE_ESLINT_TSCONFIG;
if (!project) throw new Error("RIE_ESLINT_TSCONFIG is not set");

export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { import: importPlugin },
    settings: {
      "import/parsers": { "@typescript-eslint/parser": [".ts", ".tsx", ".mts", ".cts"] },
      "import/resolver": { typescript: { project } },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "import/no-cycle": "error" },
  },
];
