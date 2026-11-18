# Handing HostelConnect over to the hostel owner

How to give the SNS Hostel owner their own account for each part of HostelConnect without
losing data. Each step says who does it, how to check it worked, and whether it can be
undone. Do them in order and one at a time; the site stays up throughout.

What is known and what is not was checked on 2026-11-18 (docs/progress.md, "Handover").
Anything marked **Check** was not confirmed in advance and must be looked at on the day.

## What there is to hand over

| Part | Where it is now | Holds | Hand over? |
|---|---|---|---|
| Supabase project `hostelconnect`, id `ycdrzvxytwqcbbufshsh` (Singapore) | The developer's Supabase organization | Every hostel's and student's records; the private photo bucket `complaint-photos` | **Yes**: step 2 |
| Supabase project `hostelconnect-dev`, id `iurrardpekxiascrncjz` | The developer's account | Nothing real: photo storage for local testing only | **No**: the live site never uses it |
| Render web service `hostelconnect` (Singapore) | The developer's Render account | The running app and its settings (secrets) | Optional: step 4 |
| GitHub repository `nick10-05/HOSTELCONNECT` (public) | The developer's GitHub | The code, CI, the nightly backup, the hourly jobs, the daily database check, and their secrets (environment `production`) | Optional: step 5 |
| Backup private key `hostelconnect-backup.key` | The developer (two copies off the laptop) | The only way to open a backup | Give the owner a copy: step 1 |
| Google Cloud project `HostelConnect` (OAuth client) | The developer's Google account | Owners' "Sign in with Google" | Optional: step 5 |
| Brevo account (Free plan) | The developer's sign-up | Sends the code for deleting a building or room | Optional: step 5 |

Moving only the Supabase project gives the owner their data. It does not hand over the
running app: Render, GitHub, Google and Brevo stay where they are, and keep working, until
they are moved too.

## 1. Before anything moves (the developer)

1. GitHub → Actions: the latest **Backup database**, **Run jobs** and **Database activity
   check** runs are green.
2. Download the newest backup and run the restore drill (`docs/RECOVERY.md`, section 9).
   It must end with "Drill passed" and show the newest file in `server/migrations/` as the
   last migration. The last drill on a production backup passed on 2026-11-18, at
   migration 024; repeat it if a migration has run since.
3. Give the owner a copy of `hostelconnect-backup.key` (in person, on a USB stick or
   through a password manager's sharing; never by email or chat). Without it the backups
   cannot be opened by anyone else.
4. Tell the owner and the students: no change for them. The address stays
   https://hostelconnect-o8e6.onrender.com.

## 2. Move the production Supabase project

Supabase's own **Transfer project** moves a project between organizations in the same
region; the database and storage go with it
([Supabase: project transfers](https://supabase.com/docs/guides/platform/project-transfer)).

**The owner:**

1. Signs up at supabase.com with the SNS Hostel email, and creates an organization on the
   **Free** plan (no card).
2. Organization settings → Team → invites the developer as a member.

**The developer:**

1. Accepts the invitation.
2. In the project `hostelconnect`, **Check** that none of these is set, since each blocks a
   transfer: an active GitHub integration (Project Settings → Integrations), log drains.
3. **Check** the SNS organization can take one more active free project (Supabase limits
   free projects per organization).
4. Project Settings → General → **Transfer project** → the SNS organization. Read the
   preview. **Check** before confirming that it shows no change to the project's id or
   address and no lost feature. If it shows either, stop: the steps below assume the id
   and address stay the same.
5. Confirm.

**Right after (the developer):**

1. `/api/health` answers `{"status":"ok"}`.
2. The owner signs in; a student profile opens.
3. A complaint photo uploads and opens (this checks the storage key still works).
4. GitHub → Actions → run **Database activity check** by hand; it is green. The next
   night's **Backup database** run is green.

**Undo:** the SNS organization can transfer it back the same way.

If the id or address did change, Render's `DATABASE_URL`, `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`, and GitHub's `DATABASE_URL` and `MIGRATION_DATABASE_URL`, must be
updated to the new values (`docs/deploy.md`, steps 1 and 2), then Render redeploys.

## 3. Who keeps access afterwards

A transfer changes no password or key. The developer, Render and GitHub keep the access
they had. That is right while the developer still maintains the app.

When the owner wants to be the only one with access, rotate, in this order
(`docs/RECOVERY.md`, section 7):

1. Supabase admin password → GitHub `MIGRATION_DATABASE_URL`.
2. App database password (`hostel_app`) → Render `DATABASE_URL` and GitHub `DATABASE_URL`.
3. A new Supabase secret key → Render `SUPABASE_SECRET_KEY`; then delete the old key.
4. Remove the developer from the SNS organization.

After each, check `/api/health`, and after 1 and 2 run **Backup database** and **Database
activity check** by hand.

## 4. Render (optional)

The app can keep running on the developer's Render account. To move it to the owner's:

- **Check** whether Render offers moving a service to another workspace on the free plan.
  If it does, invite the owner to the workspace, move the service, and check `/api/health`.
- If it does not, the owner creates a new free service from this repository
  (`docs/RECOVERY.md`, section 8). That gives a new address: update `APP_URL` in
  `.github/workflows/jobs.yml`, `PUBLIC_URL` and the Google sign-in addresses, and tell
  everyone the new address.

## 5. GitHub, Google and Brevo (optional)

- **GitHub:** the repository can be transferred to the owner's GitHub account
  (Settings → General → Transfer ownership). Its secrets and Actions history move with it;
  the owner then adds the developer back as a collaborator. Render's link to the repository must
  then be re-connected.
- **Google sign-in:** the OAuth client can stay. To move it, add the owner as an Owner of
  the Google Cloud project `HostelConnect` (IAM); nothing in Render changes.
- **Brevo:** codes are sent from the developer's verified sender. To move it, the owner
  makes a free Brevo account, verifies their own sender, creates a key restricted to
  Transactional email, and sets `BREVO_API_KEY` and `EMAIL_FROM` in Render.

## 6. If the database is paused

The owner opens Supabase → the project → **Restore project**. It takes a few minutes; no
data is lost (`docs/RECOVERY.md`, section 4). Then `/api/health` answers ok again.
Do not leave it paused: Supabase limits how long a paused free project can be restored
from the dashboard.

## What the owner needs afterwards

- Their Supabase sign-in, and the project `hostelconnect` listed in their organization.
- A copy of `hostelconnect-backup.key`, stored in two places.
- This guide and `docs/RECOVERY.md`.
- The developer's contact for anything in steps 3 to 5 not yet done.
