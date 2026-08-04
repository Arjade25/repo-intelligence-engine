import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // benchmarks/target-repo is a cloned external repo (plan §8/step 6) - its own
    // *.spec.ts files aren't ours to run and don't have their deps installed here.
    //
    // dist/** is listed explicitly and must stay that way: vitest 3's
    // configDefaults.exclude covered it, but vitest 4 trimmed that list to just
    // node_modules and .git. Relying on the defaults silently collected the
    // compiled copies of every test in dist/ after `npm run build`, doubling the
    // suite (43 -> 86) and failing on the stale build output.
    exclude: [...configDefaults.exclude, "dist/**", "benchmarks/**"],
  },
});
