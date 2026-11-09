import { parseArgs } from "node:util";
import { Client } from "pg";
import { loadDotEnv } from "../src/loadEnv";
import { runMigrations } from "./runMigrations";

// The multi-tenant rehearsal (phase 6): runs migrations 013 onward on a copy of the
// production database restored into the LOCAL Docker Postgres, then checks that nothing
// was lost and that everything landed in hostel #1. ops/rehearse-saas.sh restores the
// backup and runs this; docs/RECOVERY.md has the steps.
//   npx tsx scripts/rehearse-saas.ts --database restore_drill
// It connects with the local credentials in .env, pointed at that database, and refuses
// any other machine. It prints counts and checks only, never a name, email or phone.

const PRODUCTION_LAST = "012_polls_fees_settings.sql";

function localUrl(name: string, database: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is not set in server/.env.`);
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} does not point at this computer. The rehearsal runs on a local copy only.`);
  }
  url.pathname = `/${database}`;
  return url.toString();
}

type Check = { ok: boolean; line: string };

async function main() {
  const { database = "restore_drill" } = parseArgs({ options: { database: { type: "string" } } }).values;
  if (!/^[a-z_][a-z0-9_]*$/.test(database) || ["hostelconnect", "postgres"].includes(database)) {
    throw new Error(`Refusing to rehearse on "${database}": use the restored copy (restore_drill).`);
  }
  loadDotEnv();
  const migrationUrl = localUrl("MIGRATION_DATABASE_URL", database);
  const appUrl = localUrl("DATABASE_URL", database);

  const admin = new Client({ connectionString: migrationUrl });
  await admin.connect();
  const checks: Check[] = [];
  const check = (ok: boolean, line: string) => checks.push({ ok, line });
  try {
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await admin.query<{ n: string }>(sql, params)).rows[0].n);

    const last = (await admin.query<{ name: string | null }>("SELECT max(name) AS name FROM schema_migrations")).rows[0].name;
    console.log(`Last migration in the copy: ${last ?? "(none)"}`);
    if (last !== PRODUCTION_LAST) {
      console.log(`Note: production is at ${PRODUCTION_LAST}; this copy is not, so the rehearsal is less telling.`);
    }

    // Rows per table before.
    const tables = (
      await admin.query<{ name: string }>(
        "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY 1",
      )
    ).rows.map((r) => r.name);
    const before = new Map<string, number>();
    for (const t of tables) before.set(t, await count(`SELECT count(*) AS n FROM public."${t}"`));

    // A restored copy has no privileges (pg_restore --no-privileges: Supabase's own roles
    // do not exist here). These stand in for what migrations 001-012 gave the app role in
    // production, so the app's view can be checked after the migrations narrow it.
    await admin.query(`GRANT CONNECT ON DATABASE "${database}" TO hostel_app`);
    await admin.query("GRANT USAGE ON SCHEMA public TO hostel_app");
    await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hostel_app");
    await admin.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hostel_app");

    console.log("\nRunning the migrations...");
    const started = Date.now();
    await runMigrations({ migrationUrl, appUrl, log: (line) => console.log(`  ${line}`) });
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.\n`);

    // 1. Nothing lost or added.
    for (const t of tables) {
      const after = await count(`SELECT count(*) AS n FROM public."${t}"`);
      check(after === before.get(t), `${t}: ${before.get(t)} rows before, ${after} after`);
    }

    // 2. Hostel #1, as migrations 013 and 019 make it.
    const hostels = await admin.query<{ id: string; slug: string | null; status: string }>("SELECT id, slug, status FROM hostels");
    check(
      hostels.rowCount === 1 && hostels.rows[0].id === "1" && hostels.rows[0].slug === "sns-hostel" && hostels.rows[0].status === "active",
      `one hostel: #1, active, at sns-hostel (found ${hostels.rowCount})`,
    );

    // 3. Every row of every per-hostel table is hostel #1's.
    const perHostel = (
      await admin.query<{ name: string }>(
        "SELECT table_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'hostel_id' AND table_name <> 'hostels' ORDER BY 1",
      )
    ).rows.map((r) => r.name);
    for (const t of perHostel) {
      const elsewhere = await count(`SELECT count(*) AS n FROM public."${t}" WHERE hostel_id IS DISTINCT FROM 1`);
      check(elsewhere === 0, `${t}: ${elsewhere} rows outside hostel #1`);
    }

    // 4. Who can sign in: one owner, and every account found by the sign-in lookup.
    const owners = await count("SELECT count(*) AS n FROM users WHERE role = 'owner'");
    check(owners === 1, `owners in hostel #1: ${owners} (one owner per hostel)`);
    const lost = await count(
      `SELECT count(*) AS n FROM users u
        WHERE u.password_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM auth_user_by_email(1, u.email) a WHERE a.id = u.id)`,
    );
    check(lost === 0, `accounts with a password the sign-in lookup cannot find: ${lost}`);

    // 5. Row-level security, as the app sees it: everything in hostel #1, nothing outside.
    const total = before.get("users") ?? 0;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE hostel_app");
      await admin.query("SELECT set_config('app.hostel_id', '1', true)");
      const inside = await count("SELECT count(*) AS n FROM users");
      // Outside any hostel the database refuses (current_hostel_id(), migration 015).
      await admin.query("SELECT set_config('app.hostel_id', '', true)");
      await admin.query("SAVEPOINT outside");
      const outside = await count("SELECT count(*) AS n FROM users").then(
        (n) => `sees ${n}`,
        async (err: Error) => {
          await admin.query("ROLLBACK TO SAVEPOINT outside");
          return /No hostel is set/.test(err.message) ? "is refused" : `fails: ${err.message}`;
        },
      );
      check(
        inside === total && (outside === "is refused" || outside === "sees 0"),
        `the app sees ${inside} of ${total} accounts in hostel #1, and outside any hostel ${outside}`,
      );
    } finally {
      await admin.query("ROLLBACK");
    }

    // 6. Phase 5b: nobody is marked under 18 yet.
    const minors = await count("SELECT count(*) AS n FROM users WHERE under_18");
    check(minors === 0, `students marked under 18: ${minors}`);

    // For the owner, not a failure: fee rows start once hostel #1 has a date.
    const fees = (await admin.query<{ d: string | null }>("SELECT fees_start_date::text AS d FROM hostels WHERE id = 1")).rows[0]?.d;
    console.log(fees ? `Hostel #1's fees start date: ${fees}` : "Hostel #1 has no fees start date yet: the owner sets it in Settings.");
  } finally {
    await admin.end();
  }

  console.log("\nChecks:");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.line}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nEvery check passed.");
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
