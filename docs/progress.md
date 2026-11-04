# Progress against the 10-day plan

Plan: HostelConnect v1 Design Document, Revision 5, section 12 (day-by-day plan).
This file records what is done and how it was checked, so each day starts from facts,
not memory.

## Day 1 — design (2026-11-03)

- [x] Design document written and reviewed (Revision 5)
- [ ] Open decisions: Aadhaar storage, record book format (spreadsheet or paper)
- [x] Accounts and age key pair: done on 2026-11-04 as part of Day 3 (GitHub, Supabase,
      Render on free plans; age private key stored outside the repo)

## Day 2 — foundation (2026-11-03)

- [x] Root config: `.gitignore`, `.gitattributes`, `.nvmrc` (Node 24), `.env.example`, README
- [x] Express 5 + TypeScript server with startup config validation and `/api/health`
- [x] Local PostgreSQL 17 in Docker Compose
- [x] Migration runner; migrations 001 (limited `hostel_app` role), 002 (users),
      003 (buildings, floors, rooms, beds, stays)
- [x] Database pool; `/api/health` queries the database (503 when it is down)
- [x] Auth: password hashing, session tokens, `requireAuth` / `requireRole`; routes
      `/api/auth` login, logout, me, change-password; login rate limit
- [x] `seed:owner` script (one owner, one-time temporary password)
- [x] Client: login and change-password screens
- [x] Tests on a throwaway `*_test` database; CI with server and client jobs

## Day 3 — structure, first deploy, first backup (2026-11-03 to 2026-11-04)

| Task | Status | How it was verified |
|---|---|---|
| Structure rules (buildings, floors, rooms, beds) | Done | 29 tests in `server/tests/structure.test.ts` |
| Structure API (owner only) and owner screen | Done | Route and screen tests; checked in a browser, desktop and phone width |
| Dockerfile; Express serves the built client | Done | Image built and run locally; Render builds it |
| CSRF check on the `Origin` header | Done | Tests; production login works behind Render's proxy |
| Supabase project (Singapore, PostgreSQL 17.11) | Done | `select version()` in the SQL Editor |
| Production migrations 001–005 | Done | Workflow run #3; `schema_migrations` shows five rows |
| Supabase API roles locked out (migration 004) | Done | No `anon` / `authenticated` grants on public tables |
| Render deploy | Done | https://hostelconnect-o8e6.onrender.com; `/api/health` answers `ok` |
| Production owner account; temporary password changed | Done | Owner logged in; the restored backup shows `must_change_password = false` |
| Nightly encrypted backup | Done | First successful run, 2026-11-04 11:56 UTC (22 KB artifact) |
| Restore drill | Done | `ops/restore-drill.sh` restored the artifact locally; temporary database dropped |
| Local database at migration 005 | Done | Local `schema_migrations` lists 001–005 |
| Local owner temporary password changed | Done | Local owner has `must_change_password = false` |

Day 3 is complete.

### Known limitations carried forward

- Database connections are encrypted but do not verify Supabase's certificate
  (`sslmode=no-verify` / `require`). Verifying with Supabase's root certificate is a
  later hardening step.
- The first scheduled backup run (2026-11-04 01:36 UTC) failed because the secrets did
  not exist yet. The first run after adding them (manual, 11:56 UTC) succeeded; the
  next scheduled run is the first unattended one to watch.
- `actions/checkout` and `actions/setup-node` are at v4; bump them if GitHub warns.
- Open design decisions from the design document: temporary-password length (section 6
  says 8 characters in one place and 10 in another), Aadhaar storage, record book
  format (spreadsheet or paper).

### Differences from Revision 5 to reconcile

The Day 3 structure API was built before the design document was available in the
working session, so it differs from section 5:

| Revision 5 (section 5) | Built on Day 3 |
|---|---|
| `GET /api/buildings`: tree with students per building and bed counts | `GET /api/structure`: tree with bed occupancy, no student names or counts |
| `PATCH /api/buildings/:id` rename | Not built |
| `POST /api/buildings/:id/rooms`: several rooms at once (comma-separated), optional bed count | One room per request, no bed count |
| `PATCH /api/rooms/:id` rename or move to a floor | Not built |
| `PATCH /api/beds/:id` retire or restore | `POST /api/beds/:id/retire` and `/reactivate` |
| Structure screen shows each student's name against their room or bed (section 9) | Shows bed status only (students arrive on Day 4) |

Other differences: backup artifacts are kept 90 days (section 11 says 30 daily
copies); the recovery steps live in `docs/deploy.md` until `docs/RECOVERY.md` (Day 10);
client screens are in `client/src/owner/` and `client/src/auth/` rather than
`pages/owner/`; helmet (Content Security Policy, section 8) is not added yet.
