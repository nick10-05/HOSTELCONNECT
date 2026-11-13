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

`hostel_backup` is the nightly backup's own role: it may read every hostel's rows and
write nothing. Migration 018 creates it without a login, and it needs no password or
secret of its own: each **Backup database** run gives it a new random password with
`MIGRATION_DATABASE_URL`, dumps as `hostel_backup`, and locks it again afterwards
(`server/scripts/backup-login.ts`).

Why two `sslmode`s: both encrypt the connection. The Node `pg` driver reads `require`
as "also verify the certificate against the public CAs", which fails for Supabase's
own CA, so Node URLs say `no-verify`. `pg_dump` reads `require` as plain encryption.
Verifying Supabase's certificate is a later hardening step.

## 2. GitHub secrets

Repository → Settings → Environments → **New environment** `production` → add secrets:
`MIGRATION_DATABASE_URL`, `DATABASE_URL`, and `AGE_PUBLIC_KEY` (the `age1…` line).
Only the migrate and backup workflows use this environment. A `BACKUP_DATABASE_URL`
secret from before 2026-11-13 is no longer read and can be deleted.

## 3. Create the tables

Actions → **Migrate production database** → Run workflow (branch `main`). The log shows
`applied 001_app_role.sql` … `applied 005_app_reads_migrations.sql`. Running it again
must print only `skip` lines.

Check that Supabase's API roles can see nothing (SQL Editor, should return no rows):

```sql
select grantee, table_name from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated');
```

The backup needs no login set up by hand: the **Backup database** workflow makes one
for each run and removes it afterwards. Its log shows `hostel_backup can log in and read
every hostel: …` and, at the end, `hostel_backup is locked again`.

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

Sign in at `<Render URL>/h/sns-hostel/login` (hostel #1's address, migration 019) with
the temporary password. The app allows nothing else until
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
   empty schema has the same migrations as the backup.
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

### Moving an existing deployment to hostels (migrations 013 to 022)

Production is at 012. The hostels code needs every migration up to 022, and the code
before it stops working after 016 (rows need a hostel) and 018 (row-level security), so
the move is one short break, at a quiet hour:

1. Run **Backup database**, and download that backup.
2. Rehearse on it, on your laptop (`docs/RECOVERY.md`, section 9): every check must pass.
3. Tell the students their new sign-in address, `<Render URL>/h/sns-hostel/login`. From
   this deploy on, the plain `/login` asks for the hostel's address first (phase 6), and
   the owner signs in there with Google or at the same address with the password.
4. Render → the service → **Suspend**.
5. Run **Migrate production database** on the branch being deployed: 013 to 022.
6. Deploy that branch's code and **Resume** the service.
7. Run **Backup database** by hand and check it is green. From 018 on it dumps as
   `hostel_backup`, with a login it makes for the run (`hostel_app`, which it used
   before, now sees at most one hostel).
8. Check: `/api/health`; a student signs in at `/h/sns-hostel/login`; the owner signs in;
   the dashboard and the students list look as before; Settings → Fees and limits shows
   the fees start date to set and the limits (step "A hostel's limits").

If step 5 fails, nothing changed (each migration is all or nothing): resume the old
service and look at the log. If a problem shows after step 6, restore the step 1 backup
(section 5 of `docs/RECOVERY.md`) and deploy the previous code.

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

## A password change ends other sign-ins (migration 023)

Migration 023 adds `users.session_version`, which the database raises whenever a password
changes (a student changing it, an owner's reset, a reactivation, an owner removing it for
Google). Every sign-in carries the number it was made with, and one made before the change
stops working. The app may also raise the number, never lower it: "Sign out of other
devices" (Settings for owners, the home page for students) and an owner's "Sign out
everywhere" on a student's profile. Sign-ins from before 023 count as number 0, so nobody
is signed out by the upgrade itself. Changing a password reads the new column, so apply 023 with **Migrate
production database** before deploying this code.

## Free-plan limits to expect

- Render sleeps after 15 minutes without visits; the next visit waits about a minute
  (the login page says so).
- Supabase pauses a project after 7 days without activity. The nightly backup connects
  every day, which should count; if a pause ever happens, restore it from the dashboard.
