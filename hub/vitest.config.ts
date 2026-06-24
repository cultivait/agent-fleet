import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    include: ["src/__tests__/**/*.test.ts"],
    // Runs in every worker before any test module loads. Strips the inherited
    // AGENT_FLEET_DB_PATH (the prod store path that pm2 exports into every builder
    // shell) so the suite's :memory: isolation actually takes effect. Paired with the
    // hard guard in db.ts that throws if a test ever resolves to a real DB file.
    setupFiles: ["./src/__tests__/helpers/test-env-setup.ts"],
  },
});
