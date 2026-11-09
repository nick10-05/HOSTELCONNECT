import { z } from "zod";
import { databaseUrlProblem } from "./lib/databaseUrl";

// An empty line in .env (NAME=) means "not set", as if the line were missing.
const optional = <T extends z.ZodType>(type: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), type.optional());

// The Supabase project's address, e.g. https://abcd.supabase.co: https, nothing after the
// host. A trailing slash is dropped so paths can be appended as "/storage/v1/...".
const supabaseUrl = z
  .string()
  .transform((url) => url.replace(/\/$/, ""))
  .superRefine((url, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.addIssue({ code: "custom", message: "is not a valid URL" });
      return;
    }
    if (parsed.protocol !== "https:") ctx.addIssue({ code: "custom", message: "must start with https://" });
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      ctx.addIssue({ code: "custom", message: "must be the project address only, with no path" });
    }
  });

// The address people open the app at, e.g. https://hostelconnect-o8e6.onrender.com: https
// (or http for this machine), nothing after the host. Google sends owners back to it.
const publicUrl = z
  .string()
  .transform((url) => url.replace(/\/$/, ""))
  .superRefine((url, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      ctx.addIssue({ code: "custom", message: "is not a valid URL" });
      return;
    }
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
      ctx.addIssue({ code: "custom", message: "must start with https:// (http:// only for localhost)" });
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      ctx.addIssue({ code: "custom", message: "must be the site's address only, with no path" });
    }
  });

// Every setting the server needs, checked once at startup.
// If something is missing or wrong, the server refuses to start with a clear message
// instead of failing later in some random request.
const fields = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().superRefine((url, ctx) => {
    const problem = databaseUrlProblem(url);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  // Complaint limits (design doc, sections 2 and 9): active complaints per student, and
  // new complaints per student in any 24 hours. The third limit, one active complaint
  // per category, is a database index and has no setting.
  COMPLAINT_MAX_ACTIVE: z.coerce.number().int().min(1).max(50).default(3),
  COMPLAINT_MAX_NEW_PER_DAY: z.coerce.number().int().min(1).max(50).default(2),

  // The usage guard (section 10), set below Supabase's free limits (decided on day 8):
  // photo uploads switch off at 85% of either, the dashboard turns amber at 70%.
  STORAGE_LIMIT_MB: z.coerce.number().int().min(1).default(450),
  EGRESS_LIMIT_MB: z.coerce.number().int().min(1).default(3000),
  // The server's cap on one photo (section 8, default 1 MB); the browser sends about 500 KB.
  PHOTO_MAX_BYTES: z.coerce.number().int().min(1).max(10 * 1024 * 1024).default(1024 * 1024),
  // How long a signed photo link works (decided on day 8).
  PHOTO_LINK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),

  // Supabase Storage. The secret key (sb_secret_... or the older service_role key) never
  // reaches the browser. Without these two, local development and tests use fake storage.
  SUPABASE_URL: optional(supabaseUrl),
  SUPABASE_SECRET_KEY: optional(z.string().min(20, "must be at least 20 characters")),
  // A private bucket; Supabase allows lowercase letters, digits and hyphens.
  STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "must be lowercase letters, digits and hyphens")
    .default("complaint-photos"),

  // The header POST /api/internal/run-jobs requires (section 8). Unset, the endpoint is off.
  JOB_SECRET: optional(z.string().min(32, "must be at least 32 characters")),

  // The go-live date for fees (section 9; decided on day 9): no fee row is created for a
  // due date before it, so earlier payments stay in the owner's record book. Unset, the
  // fee-rows job creates nothing; production runs without it until the real register is
  // imported.
  FEES_START_DATE: optional(z.iso.date("must be a date written as YYYY-MM-DD")),

  // "true" sends the Content Security Policy as report-only: browsers warn in the console
  // instead of blocking. For trying the policy on the live site before enforcing it.
  CSP_REPORT_ONLY: optional(z.enum(["true", "false"], "must be true or false"))
    .transform((value) => value === "true"),

  // Google sign-in for owners (multi-tenant phase 3b), from the OAuth client in Google
  // Cloud Console. All three or none; without them, sign-in with Google is off.
  GOOGLE_CLIENT_ID: optional(
    z.string().regex(/^[\w-]+\.apps\.googleusercontent\.com$/, "must be an OAuth client id ending in .apps.googleusercontent.com"),
  ),
  GOOGLE_CLIENT_SECRET: optional(z.string().min(10, "must be at least 10 characters")),
  PUBLIC_URL: optional(publicUrl),
});

// Settings that only make sense together, or that production cannot run without: a
// missing Render setting stops the deploy instead of quietly switching photos off.
const schema = fields.superRefine((config, ctx) => {
  const missing = (name: keyof typeof config, message: string) =>
    ctx.addIssue({ code: "custom", path: [name], message });

  if (config.SUPABASE_URL && !config.SUPABASE_SECRET_KEY) {
    missing("SUPABASE_SECRET_KEY", "is required when SUPABASE_URL is set");
  }
  if (config.SUPABASE_SECRET_KEY && !config.SUPABASE_URL) {
    missing("SUPABASE_URL", "is required when SUPABASE_SECRET_KEY is set");
  }
  const google = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_URL"] as const;
  if (google.some((name) => config[name]) && !google.every((name) => config[name])) {
    for (const name of google) {
      if (!config[name]) missing(name, "is required for Google sign-in, with the other two GOOGLE_ settings and PUBLIC_URL");
    }
  }
  if (config.NODE_ENV === "production") {
    for (const name of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "JOB_SECRET"] as const) {
      if (!config[name]) missing(name, "is required in production");
    }
  }
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
