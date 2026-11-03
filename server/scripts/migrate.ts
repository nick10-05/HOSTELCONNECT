import { z } from "zod";
import { loadDotEnv } from "../src/loadEnv";
import { runMigrations } from "./runMigrations";

async function main() {
  loadDotEnv();
  const env = z
    .object({
      MIGRATION_DATABASE_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
    })
    .parse(process.env);

  await runMigrations({ migrationUrl: env.MIGRATION_DATABASE_URL, appUrl: env.DATABASE_URL });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
