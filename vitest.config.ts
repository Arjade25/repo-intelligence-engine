import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // benchmarks/target-repo is a cloned external repo (plan §8/step 6) - its own
    // *.spec.ts files aren't ours to run and don't have their deps installed here.
    // Extends (not replaces) vitest's defaults, which already exclude dist/**.
    exclude: [...configDefaults.exclude, "benchmarks/**"],
  },
});
