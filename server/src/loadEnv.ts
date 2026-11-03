import path from "node:path";

// Local development only: read the .env in the repo root.
// On Render the variables come from the host, so a missing file is fine.
// Variables already set in the real environment are never overwritten.
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.resolve(__dirname, "../../.env"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
