import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Recreates and migrates the *_test database once per run.
    globalSetup: ["tests/globalSetup.ts"],
    // Loads the repo-root .env locally and points DATABASE_URL at the test database.
    setupFiles: ["tests/setup.ts"],
  },
});
