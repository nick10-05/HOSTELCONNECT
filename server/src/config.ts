import { z } from "zod";

// Every setting the server needs, checked once at startup.
// If something is missing or wrong, the server refuses to start with a clear message
// instead of failing later in some random request.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
});

export type Config = z.infer<typeof schema>;

// Takes the environment as an argument (instead of reading process.env directly)
// so tests can pass in fake values.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only names and problems are listed, never the values: secrets must not reach logs.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  return result.data;
}
