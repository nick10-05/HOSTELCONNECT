import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Loads the repo-root .env locally; in CI the variables come from the workflow.
    setupFiles: ["tests/setup.ts"],
  },
});
