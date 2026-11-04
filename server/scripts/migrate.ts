import { loadDotEnv } from "../src/loadEnv";
import { databaseUrlProblem } from "../src/lib/databaseUrl";
import { runMigrations } from "./runMigrations";

const NAMES = ["MIGRATION_DATABASE_URL", "DATABASE_URL"] as const;

async function main() {
  loadDotEnv();

  // Check both before connecting, and name each bad one. Never print a value: these
  // hold passwords, and this output ends up in the GitHub Actions log.
  const problems = NAMES.flatMap((name) => {
    const problem = databaseUrlProblem(process.env[name] ?? "");
    return problem ? [`${name} ${problem}`] : [];
  });
  if (problems.length) throw new Error(problems.join("\n"));

  await runMigrations({
    migrationUrl: process.env.MIGRATION_DATABASE_URL!.trim(),
    appUrl: process.env.DATABASE_URL!.trim(),
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
