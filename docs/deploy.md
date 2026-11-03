# Deploying HostelConnect

How the pieces fit:

```
GitHub (main) ──CI passes──▶ Render: one Docker container (Express + built React app), Singapore
                                  │  hostel_app login, through Supabase's session pooler
                                  ▼
                             Supabase Postgres, Singapore
                                  ▲
GitHub Actions, nightly ──────────┘  pg_dump → encrypted with age → kept 90 days as an artifact
```

Everything here is on free plans. Steps 0–5 are done once, in order.

## 0. Backup key (on your laptop)

Backups are encrypted to a key pair. The public key goes to GitHub; the private key
never leaves your hands. **Lose the private key and every backup is unreadable.**

```powershell
winget install FiloSottile.age
age-keygen -o hostelconnect-backup.key
```

It prints `Public key: age1…`; that line is safe to share. Keep `hostelconnect-backup.key`
in two places that are not this laptop (e.g. a USB stick and your password manager).
Never put it in the repo (`.gitignore` already blocks `*.key`).

## 1. Supabase

1. Sign up at supabase.com (log in with GitHub) and create a project:
   name `hostelconnect`, region **Southeast Asia (Singapore)**, and let it generate the
   database password. Save that password in your password manager: it is the **admin
   password** (role `postgres`), used only for migrations.
2. SQL Editor → run `select version();`. If it is not PostgreSQL 17, the image tag
   `postgres:17-alpine` must change everywhere it appears (docker-compose.yml, the three
   workflows, both `ops/` scripts) so dumps and local tests match production.
3. Project Settings → Data API → turn it **off**. HostelConnect never uses it, and
   migration 004 also removes its roles' rights to our tables.
4. Make a second password, for the app's own login (`hostel_app`):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
   (base64url has no characters that need escaping in a URL.)
5. Click **Connect** → **Session pooler**. Note the host
   (like `aws-0-ap-southeast-1.pooler.supabase.com`), port `5432`, and the project ref
   in the user name (`postgres.<ref>`). Session mode, not transaction mode: migrations
   need a whole session for their lock. Do not use the "direct connection": on the free
   plan it is IPv6 only, which Render and GitHub Actions cannot reach.

Build these URLs (replace the `<…>` parts):

| Name | Value |
|---|---|
| `MIGRATION_DATABASE_URL` | `postgres://postgres.<ref>:<ADMIN_PW>@<pooler-host>:5432/postgres?sslmode=no-verify` |
| `DATABASE_URL` | `postgres://hostel_app.<ref>:<APP_PW>@<pooler-host>:5432/postgres?sslmode=no-verify` |
| `BACKUP_DATABASE_URL` | the `DATABASE_URL` above, ending in `?sslmode=require` instead |

Why two `sslmode`s: both encrypt the connection. The Node `pg` driver reads `require`
as "also verify the certificate against the public CAs", which fails for Supabase's
own CA, so Node URLs say `no-verify`. `pg_dump` reads `require` as plain encryption.
Verifying Supabase's certificate is a later hardening step.

## 2. GitHub secrets

Repository → Settings → Environments → **New environment** `production` → add secrets:
`MIGRATION_DATABASE_URL`, `DATABASE_URL`, `BACKUP_DATABASE_URL`, and `AGE_PUBLIC_KEY`
(the `age1…` line). Only the migrate and backup workflows use this environment.

## 3. Create the tables

Actions → **Migrate production database** → Run workflow (branch `main`). The log shows
`applied 001_app_role.sql` … `applied 005_app_reads_migrations.sql`. Running it again
must print only `skip` lines.

Check that Supabase's API roles can see nothing (SQL Editor, should return no rows):

```sql
select grantee, table_name from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');
```

## 4. Render

1. Sign up at render.com with GitHub.
2. New → **Blueprint** → choose the HostelConnect repository. Render reads `render.yaml`.
3. It asks for `DATABASE_URL`: paste the one from step 1. `JWT_SECRET` is generated
   by Render; `NODE_ENV` is set to `production`.
4. Deploy. The first build takes a few minutes. When it is live,
   `https://<service>.onrender.com/api/health` answers `{"status":"ok"}`.

From then on, every push to `main` deploys by itself once CI has passed.

## 5. Owner account

Once, from your laptop, in the `server` folder (PowerShell). The variable set here
takes priority over `.env`, and is removed afterwards:

```powershell
$env:DATABASE_URL = "<DATABASE_URL from step 1>"
npm run seed:owner -- --name "Your Name" --email you@example.com
Remove-Item Env:DATABASE_URL
```

It prints a temporary password once. Log in on the Render URL and change it.

## 6. First backup and restore drill

1. Actions → **Backup database** → Run workflow. It then runs every night at 03:00 IST.
2. Open the finished run → Artifacts → download it, and unzip: you get
   `hostelconnect-<date>.dump.age`.
3. With the local Docker database running (`docker compose up -d`), in Git Bash:
   ```bash
   bash ops/restore-drill.sh hostelconnect-<date>.dump.age /path/to/hostelconnect-backup.key
   ```
   It loads the backup into a throwaway local database, prints the row count of every
   table and drops it again. Repeat monthly: an untested backup is not a backup.

The repository is public, so anyone signed in to GitHub can download these artifacts;
without your private key they are unreadable. GitHub keeps each for 90 days, and pauses
nightly runs after 60 days without a commit (it emails first; re-enable in Actions).

## Recovery: the database is lost or damaged

1. Create a new Supabase project (step 1) and update the three URL secrets (step 2).
2. Run **Migrate production database** on the commit that matches the backup, so the
   empty schema has the same migrations as the backup.
3. Load the rows (Git Bash; the admin URL ends in `?sslmode=require` here):
   ```bash
   bash ops/restore-data.sh hostelconnect-<date>.dump.age /path/to/hostelconnect-backup.key "postgres://postgres.<ref>:<ADMIN_PW>@<pooler-host>:5432/postgres?sslmode=require"
   ```
   It refuses a database that already has users, and loads everything or nothing.
4. In Render, set the new `DATABASE_URL` and redeploy.

## Later schema changes

A pull request with a new migration: run **Migrate production database** on that branch
first, then merge. Migrations only ever add, so the running code keeps working while the
new tables arrive, and the new code never starts without them.

## Free-plan limits to expect

- Render sleeps after 15 minutes without visits; the next visit waits about a minute
  (the login page says so).
- Supabase pauses a project after 7 days without activity. The nightly backup connects
  every day, which should count; if a pause ever happens, restore it from the dashboard.
