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
| `BACKUP_DATABASE_URL` | `postgres://hostel_backup.<ref>:<BACKUP_PW>@<pooler-host>:5432/postgres?sslmode=require` |

`<BACKUP_PW>` is a third password, made the same way as the app's. `hostel_backup` is
the nightly backup's own role: it may read every hostel's rows and write nothing. It is
created by migration 018 without a login; step 3 gives it this password.

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

Then give the backup its login (migration 018 on): from `server/`, in PowerShell, with
the two URLs set in this window only, never in `.env`:
```powershell
$env:MIGRATION_DATABASE_URL = Read-Host "Paste MIGRATION_DATABASE_URL"
$env:BACKUP_DATABASE_URL = Read-Host "Paste BACKUP_DATABASE_URL"
npx tsx scripts/backup-role.ts
Remove-Item Env:MIGRATION_DATABASE_URL, Env:BACKUP_DATABASE_URL
```
It prints `hostel_backup can log in and read every hostel: …`. Running it again sets the
password again (to change it).

## 4. Render

1. Sign up at render.com with GitHub.
2. New → **Blueprint** → choose the HostelConnect repository. Render reads `render.yaml`.
3. It asks for `DATABASE_URL`: paste the one from step 1. `JWT_SECRET` is generated
   by Render; `NODE_ENV` is set to `production`.
4. Deploy. The first build takes a few minutes. When it is live,
   `https://<service>.onrender.com/api/health` answers `{"status":"ok"}`.

From then on, every push to `main` deploys by itself once CI has passed.

## 5. Owner account

Once, from your laptop, in a new PowerShell window. A variable set in the window takes
priority over `.env`, so the script writes to production, not your local database.

Never type a URL with a password into a command: PowerShell saves every typed command
to a history file on disk. Paste it at a hidden prompt instead, which is not saved:

```powershell
cd C:\Users\NICK\projects\HOSTELCONNECT\server
$s = Read-Host "Paste production DATABASE_URL" -AsSecureString; $env:DATABASE_URL = [Net.NetworkCredential]::new('', $s).Password; Remove-Variable s
npm run seed:owner -- --name "Your Name" --email you@example.com
```

It prints a temporary password once. Copy it straight into your password manager, then
clear the screen, remove the variable and close the window:

```powershell
Clear-Host; Remove-Item Env:DATABASE_URL
```

Log in on the Render URL with the temporary password. The app allows nothing else until
you choose a new one (the server enforces this too). If the script says an owner
already exists, it changed nothing.

## 5a. Google sign-in for owners (multi-tenant phase 3b)

Owners sign in with their Google account. Until the three settings below are in Render,
the sign-in page shows no Google button and nothing else changes.

1. console.cloud.google.com → create a project, e.g. `HostelConnect`.
2. **Google Auth Platform** (or APIs & Services → OAuth consent screen) → Get started:
   app name `HostelConnect`, your email as support and developer contact, audience
   **External**. Under Data access the app needs only `openid` and `.../auth/userinfo.email`,
   which need no review by Google.
3. **Clients** → Create client → **Web application**, name `HostelConnect web`.
   - Authorized JavaScript origins: none needed.
   - Authorized redirect URIs: `https://<service>.onrender.com/api/auth/google/callback`
     (exactly, with https and no trailing slash).
4. Copy the client ID and the client secret. The secret is shown in full only now; keep
   it in your password manager.
5. Render → Environment → add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
   `PUBLIC_URL` = `https://<service>.onrender.com` → save (redeploys).
6. While the consent screen is in **Testing**, only the Google accounts listed under
   Audience → Test users can sign in. Add yours. Publish the app (Audience → Publish)
   before other owners sign up (phase 4).

Then, for the existing owner account:

1. Sign in with the password as before → Settings → **Sign-in** → **Link Google account**,
   and choose your Google account. Settings then says it is linked.
2. Sign out, and sign in with **Sign in with Google** to check it works.
3. Back in Settings → **Remove password**, with the current password. From then on only
   Google signs you in (decided in phase 0). If Google sign-in ever breaks before that
   step, the password still works; after it, `npm run reset:owner-password` gives the
   owner a password again (docs/RECOVERY.md).

## 5b. Opening sign-up to new hostels (multi-tenant phase 4a)

Anyone with a Google account can then create a hostel and become its owner. Sign-up stays
closed (`SIGNUPS_OPEN` unset or `false`) until all of these are true:

1. Google sign-in works (step 5a), and the consent screen is **published** (Audience →
   Publish), so that any Google account can sign in, not only the test users.
2. The Terms of Service and the Privacy Policy (`/terms`, `/privacy`) are final and a
   lawyer has reviewed them. Whenever either changes in substance, change `TERMS_VERSION`
   in `server/src/lib/legal.ts`: each owner's account records the version they accepted.
3. Render → Environment → `SIGNUPS_OPEN` = `true` → save (redeploys). The server refuses
   to start with it on and Google sign-in off.

How it works: an unknown Google account at **Sign in with Google** is sent to `/signup`
instead of being told it has no account. There the owner names themself and the hostel,
chooses its address (`/h/<address>/login`) and accepts the terms. Five hostels an hour at
most from one IP address. To close sign-up again, set `SIGNUPS_OPEN` = `false`: hostels
that signed up keep working.

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

The full recovery guide (the site down, a paused database, one bad change, the owner's lost
password, rotating secrets) is [RECOVERY.md](RECOVERY.md). In short, for a lost database:

1. Create a new Supabase project (step 1) and update the three URL secrets (step 2).
2. Run **Migrate production database** on the commit that matches the backup, so the
   empty schema has the same migrations as the backup. Then give the backup its login
   again (`scripts/backup-role.ts`, step 3): the new project's `hostel_backup` has none.
3. Load the rows, in Git Bash. Paste the admin URL (ending in `?sslmode=require` here)
   at the hidden `read` prompt: Bash saves typed commands to a history file, and only
   the name `$RESTORE_URL` ends up there, never the URL.
   ```bash
   read -rsp "Paste the admin URL: " RESTORE_URL; echo
   bash ops/restore-data.sh hostelconnect-<date>.dump.age /path/to/hostelconnect-backup.key "$RESTORE_URL"
   unset RESTORE_URL
   ```
   It refuses a database that already has users, and loads everything or nothing.
4. In Render, set the new `DATABASE_URL` and redeploy.

## Later schema changes

A pull request with a new migration: run **Migrate production database** on that branch
first, then merge. Migrations only ever add, so the running code keeps working while the
new tables arrive, and the new code never starts without them.

### Moving an existing deployment to hostels (migrations 013 to 018)

These need the code in between, so the order matters:

1. Run **Backup database**, and keep that backup.
2. Migrate with the code before the hostels change: 013, 014 and 015 only.
3. Deploy the hostels code (Render).
4. Migrate again: 016, 017 and 018.
5. At once after 018: make `<BACKUP_PW>`, run `scripts/backup-role.ts` (step 3), and
   set the GitHub secret `BACKUP_DATABASE_URL` to the `hostel_backup` URL (step 1's
   table). Until then the nightly backup fails: `hostel_app`, which it used before, now
   sees at most one hostel. Then run **Backup database** by hand to check it.

## A hostel's limits (multi-tenant phase 5a)

Every hostel may have 300 current students and 20 buildings during the beta. Admitting,
reactivating or letting back a student past the limit, or adding a building past it, is
refused with a message telling the owner to ask for more. The owner sees the numbers in
Settings → Fees and limits. Only the migration credential can change a limit: in the
Supabase SQL editor (or `psql "<MIGRATION_DATABASE_URL>"`):

```sql
SELECT id, name, slug, student_limit, building_limit FROM hostels ORDER BY id;
UPDATE hostels SET student_limit = 400 WHERE slug = '<their-address>';
```

Before the real register goes into hostel #1, check its limits suit it.

Photo storage is shared too: each hostel's photos are counted against an equal share of
`STORAGE_LIMIT_MB` (the limit divided by the number of active hostels), and that hostel's
photo uploads switch off at 85% of its share. All hostels' photos together still count
against the whole limit. The owner sees their share on the dashboard.

## Importing a hostel's register (multi-tenant phase 5b)

The import goes into one hostel, named by its address (its slug), on behalf of its one
owner, within its limits. From `server/`, with `DATABASE_URL` set to the app's
connection:

```
npm run import:students -- --hostel sns-hostel --file C:\path\students.csv --out C:\Users\you\Documents\credentials.html
```

Start from `docs/import-template.csv`. The last two columns may be left out: `under_18`
(`yes` for a student under 18) and `guardian_consent` (`yes` once the owner has a
parent's or guardian's consent for them, which `under_18` needs). The import records
the owner as having confirmed it.

## Students under 18 (multi-tenant phase 5b)

Migration 022 adds `users.under_18`, and who confirmed a guardian's consent and when. The
owner ticks "Under 18" and confirms the consent when admitting or editing a student; the
profile shows who confirmed it and on which day. The record is kept after the student is
unmarked. Apply 022 with **Migrate production database** before deploying this code.

## Free-plan limits to expect

- Render sleeps after 15 minutes without visits; the next visit waits about a minute
  (the login page says so).
- Supabase pauses a project after 7 days without activity. The nightly backup connects
  every day, which should count; if a pause ever happens, restore it from the dashboard.
