# Progress against the 10-day plan

Plan: HostelConnect v1 Design Document, Revision 5, section 12 (day-by-day plan).
This file records what is done and how it was checked, so each day starts from facts,
not memory.

## Day 1 — design (2026-11-03)

- [x] Design document written and reviewed (Revision 5)
- [ ] Open decisions: Aadhaar storage (still open); record book format decided on day 4:
      a paper register
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
- Open design decisions from the design document: Aadhaar storage. (Temporary-password
  length and the record book format were decided on day 4.)

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

Decided on day 4 (2026-11-04), after checking the owner's record book:

- **Veg days.** Some non-veg students avoid non-veg on particular weekdays. Migration 006
  adds `users.veg_days` (weekday numbers, 1 = Monday ... 7 = Sunday), allowed only for
  non-veg students. Day 8's food count for a day must add non-veg students whose veg days
  include that day to the veg side. Weekly days only; whole periods (such as a festival
  month) are not modelled.
- **The record book is a paper register** with emails, category details, food habits and
  individual fees, so it is typed into the import CSV template once.

Other differences: backup artifacts are kept 90 days (section 11 says 30 daily
copies); the recovery steps live in `docs/deploy.md` until `docs/RECOVERY.md` (Day 10);
client screens are in `client/src/owner/` and `client/src/auth/` rather than
`pages/owner/`; helmet (Content Security Policy, section 8) is not added yet.

## Day 4 — students and import (2026-11-04)

Done when: the owner admits a student into a building with an individual temporary
password, the student is forced to change it, the directory searches and filters, and the
CSV import loads a test file. All four were met on the local database, and the code is
live in production (see "Deployment" below).

| Task | Who | Status | How it was verified |
|---|---|---|---|
| Temporary password generator (10 characters, no look-alikes; decided over 8) | Nikhil | Done | 7 tests in `tempPassword.test.ts`; `seed:owner` uses it |
| Admission transaction (user and first stay, `POST /api/students`) | Nikhil | Done | 12 tests in `students.test.ts`, including two admissions racing for one bed |
| Must-change gate for an admitted student | Nikhil (day 2) | Done | `admissionFlow.test.ts`: admit, log in, blocked, change password, let through |
| Due-date function (`nthDueDate`, month-end clamping) | Nikhil | Done | 12 tests in `fees.test.ts`, leap years and the century rule included |
| Admission form with category fields and building, room and bed pickers | Claude | Done | Screen tests; admitted a fake student in a browser, desktop and phone width |
| Directory and profile (`GET /api/students`, `GET /api/students/:id`) | Claude | Done | Service and route tests; searched, filtered, paged and opened a profile in a browser |
| Veg days (migration 006) | Claude | Done | Database, route and screen tests; saved and shown in a browser |
| `import-students` and its CSV template | Claude | Done | 14 tests; imported a fake 10-row file locally; a second run and a sheet path inside the project were refused |
| `seed-200-students` | Claude | Done | 6 tests; seeded locally: 202 current students over 11 pages, 10 former |
| Owner password reset script (planned for day 10, pulled forward) | Claude | Done | 9 tests; used to reset the local owner |

Checks at the end of the day: server 273 tests, client 58 tests, typecheck and builds clean.

### Deployment (2026-11-04, UTC)

| Step | Evidence |
|---|---|
| Day 4 committed on `day-4` | `c7427db`, author nick10-05 |
| CI on `day-4` | Run 41865084494: server and client green (delayed by a GitHub Actions outage) |
| Migration 006 on production, before the merge | "Migrate production database" run #4 on `day-4` at 16:37: 001–005 skipped, 006 applied |
| Backup after the migration | "Backup database" run #3 at 16:45: `hostelconnect-2026-11-04T1645Z.dump.age`, 23,364 bytes, kept 90 days |
| `day-4` merged into `main` | Fast-forward to `c7427db`, pushed |
| CI on `main` | Run 41871007616 green |
| Render deploy | `/api/health` answers `ok`; `/api/students` answers 401 without a login (was 404); `/students` and `/students/new` serve the app; a cross-site POST is refused with 403 |
| Owner check | Signed in on production; Students ("No students yet") and Admit student load; nothing was submitted |

Day 4 is complete. Production has no students yet: the real register is imported at
go-live, a separate step.

### Notes for later days

- Food counts (day 8) must add non-veg students to the veg side on their veg days.
- The import and the seed refuse any database that is not on this machine. Importing the
  real register into production is a separate go-live step.
- Development: the Vite proxy now keeps the browser's `Host` header (`changeOrigin: false`).
  Vite 8 rewrote it, so the Origin check refused every login through the dev server.
- Not in v1 scope and not built: editing a student (`PATCH /api/students/:id`). Transfer,
  deactivation, reactivation and student password reset belong to day 5; fee history to day 9.
- The directory does not search phone numbers, because the search is part of the page
  address and phone numbers never go in URLs.
- Watch the first unattended nightly backup (03:00 IST on 2026-11-05), carried over from day 3.

## Day 5 — transfers, reactivation, rejoin requests, notifications (2026-11-04 to 2026-11-05)

Done when: a transfer keeps history and refuses an occupied bed; deactivate and reactivate
work; the access-request form and the owner's approval work; the bell works. All four were
met on the local database. Not in production yet (see "Deployment" below).

| Task | Who | Status | How verified |
|---|---|---|---|
| Transfer transaction (`transferStudent`) | Nikhil | Done | 20 tests in `transfer.test.ts`: history kept, occupied and retired beds, same place, same day, two students racing for one bed, two transfers of one student |
| Reassigning a stay that has not started (migration 007: place grant and trigger) | Claude (migration), Nikhil (service path) | Done | 7 database tests in `accommodation.test.ts`; 5 reassignment tests; the trigger's refusal answers 409 `stay_started` |
| Transfer route and screen | Claude | Done | 10 route tests; screen tests; transferred a fake student in a browser, desktop and phone width |
| Move-out (`deactivateStudent`) | Nikhil | Done | 10 tests in `deactivation.test.ts`, two move-outs and a move-out racing a transfer included; `moveOutFlow.test.ts`: an open session gets 401 at once |
| Reactivation (`reactivateStudent`, core `reactivateInTransaction`) | Nikhil | Done | 15 tests in `reactivation.test.ts`, the move-out-day rule and the cancelled booking included; the end-to-end flow: the old password is refused, the new one is held at the must-change gate |
| Move-out and reactivation routes and screens | Claude | Done | 17 route tests; screen tests; moved out and reactivated a fake student in a browser |
| Migration 008 (`rejoin_requests`, `notifications`) | Claude | Done | 11 database tests in `peopleTables.test.ts` |
| Access-request service with the same-answer rule (`requestRejoin`) | Nikhil | Done | 13 tests in `rejoin.test.ts`: only a former student gets a request, a bad message gets the same 400 for every email, five requests at once make one |
| Access-request route, rate limits and Request access page | Claude | Done | 11 route tests on the real database (byte-identical answers, both limits, a known and an unknown email counted alike); 6 screen tests; the endpoint answered correctly on the dev server without cookies |
| Owner's review: list and reject | Claude | Done | 6 tests in `rejoinReview.test.ts` |
| Approval (`approveRejoinRequest`) | Nikhil | Done | 7 tests: refusals pass through with nothing changed, two approvals, an approval racing a rejection, an approval racing a profile reactivation |
| Review routes and Rejoin requests page | Claude | Done | 18 route tests; 8 screen tests; approved one and rejected one fake student's request in a browser |
| `notify()` | Nikhil | Done | 8 tests in `notify.test.ts`: active users only, a dedup key reaches each person once, part of the caller's transaction |
| Notification routes and the bell | Claude | Done | 6 service and 9 route tests; 11 screen tests, polling with a fake clock included; checked in a browser with 3 local sample notifications, desktop and phone width |
| Dashboard: students and rejoin requests cards | Claude | Done | 6 service, 2 route and 6 screen tests; the page's numbers matched a direct count in the local database |

Checks at the end of the day: server 450 tests (273 on day 4), client 111 (58), typecheck and
builds clean.

Found in review and fixed on the day:

- **Approval deadlock.** Approval locked the rejoin request and then the student; a profile
  reactivation locks the student and then the request. Forced together, they deadlocked in 29
  of 30 tries (Postgres 40P01, which would have been a 500). Approval now locks the student
  first, like every other path; a race test covers it.
- **Message leak on the request form.** The database checks a message's length only when it
  inserts a row, that is only for a real former student, so a bad message would have answered
  differently for them. The route and the service now both refuse it first, the same way for
  every email.
- **Test isolation.** A test broadcasting to all active students committed its rows, and a test
  file running in parallel received them. Broadcast tests now run in a rolled-back transaction,
  and the bell's tests use owners, whom a student broadcast cannot reach.
- **Bell on a phone.** The panel ran off the left edge of the screen; it now spans the screen
  on small widths.

### Decisions made on day 5

- **Transfers.** A move to the same building, room and bed is refused (409 `same_place`). A
  same-day transfer is allowed, so a wrong bed chosen at admission can be fixed.
- **A stay that has not started** (a future joining date) is moved in place, with no history
  row; once it has started, a move is a transfer. Migration 007 lets the app role change a
  stay's building, room and bed, and its trigger allows that only before the stay starts, by
  India's date. A stay starting today counts as started.
- **Moving out a booking that has not started** ends its stay on its own start date, since an
  end date may not come before the start.
- **Reactivation** takes a new joining date no earlier than the day the student moved out
  (`deactivated_at` in India's time, else the latest end date) and at most 30 days ahead. Both
  ways back, from the profile and by approving a request, close the student's pending request
  as approved.
- **Locking order:** the student's `users` row first, then the rejoin request, on every path.
- **Access requests** always answer 202 and the same sentence. Limits: 10 per IP per hour and 3
  per email per day, kept in memory like the login limit (they reset when the server sleeps).
- **Notifications** reach active users only; a dedup key reaches each person once. The bell
  shows the latest 20 and checks every minute, only while the tab is visible.
- **Dashboard.** It is the owner's home page. Students who have not arrived yet are counted,
  and their beds count as occupied.
- **Student password reset** stays out of day 5: it is part of v1 (sections 2, 5 and 6) but no
  day in section 12 assigns it. To be scheduled.

### Notes for later days

- Announcements (day 7) and return polls (day 9) notify with `notify(c, "active_students", …)`
  inside their own transaction. Notification text must never contain a phone number.
- Tests share one database and files run in parallel: a test that notifies all active students
  must run in a rolled-back transaction, and tests that count a person's notifications should
  use people no broadcast can reach.
- The day 8 job prunes notifications older than 60 days; the owner's daily digest (day 10)
  includes pending rejoin requests.
- Local development data now includes 3 sample notifications for the owner and transfer, move-out
  and rejoin history for fake seed students (Aarav Gupta, Sana Kapoor, Siddharth Pillai).

### Deployment (2026-11-05, UTC)

| Step | Evidence |
|---|---|
| Backup before the migrations | "Backup database" run #4 at 00:23 on `main`: `hostelconnect-2026-11-05T0023Z.dump.age`, 23,364 bytes (the same as run #3: production unchanged since), kept until 2027-02-03 |
| Day 5 pushed on `day-5` | `20df3f9`, author nick10-05; 8 commits ahead of `main` |
| CI on `day-5` | Run #15 at 00:27: server and client green, every step (migrations 001–008 on an empty database, a second run changing nothing, tests, builds, dependency audit) |
| Migrations 007 and 008 on production, before the merge | "Migrate production database" run #5 at 00:33 on `day-5` (`20df3f9`), success; 001–006 skipped, 007 and 008 applied (per the run's log, as reported by Nikhil) |
| Evidence above committed on `day-5` | `d46cd86`; CI run #16 green |
| `day-5` merged into `main` | Fast-forward `629ef73..d46cd86`, pushed |
| CI on `main` | Run #17 green: server and client, every step |
| Render deploy | `/api/health` answers `ok`; `/api/dashboard`, `/api/notifications` and `/api/rejoin-requests` answer 401 without a login (404 before); an unknown `/api` path still 404; a cross-site POST is refused with 403; `/`, `/rejoin-requests` and `/request-access` serve the app; the served bundle contains the new screens |
| Owner check | Signed in on production: the Dashboard is the home page (buildings with 0 students, no requests waiting), the bell shows no notifications, Rejoin requests shows none; nothing was submitted |

Day 5 is complete and live. Production still has no students: the real register is imported at
go-live, a separate step.

Not checked: the optional read-only query in the Supabase SQL Editor confirming that `anon` and
`authenticated` have no rights on `rejoin_requests` and `notifications` (migration 004 should
keep them out, as it did for the tables checked on day 3).

The first unattended nightly backup (due 03:00 IST on 2026-11-05, 21:30 UTC on 2026-11-04) had
not run by 00:33 UTC; the workflow is active. GitHub can start scheduled runs hours late (run #1
started four hours after its slot), so check the Actions tab later today.

### Known issue: occasional test-worker crash on Windows (left as is)

- **What:** now and then a local `npx vitest run` in `server/` ends with "Vitest caught 1
  unhandled error" and one test file does not run. The cause is `Worker exited
  unexpectedly with exit code 3221226505` (0xC0000409, a native fast-fail crash of the
  Node.js child process). Every test that does run passes; a re-run is enough.
- **Seen:** 4 times in about 30 full runs on 2026-11-04/05, always soon after new test
  files were written, each time in a different file (`rejoinReview.test.ts` among them).
  Node v24.15.0, Vitest 5.1.0, default `forks` pool.
- **Checked (2026-11-05):** 15 unchanged runs and 15 runs with `--pool=threads` all passed
  (442/442) with no crash; the Windows Application log has no `node.exe` crash entry. Not
  a database clash, not one test, not a native addon (there are none).
- **Best-supported explanation (not proven):** it happens to Node child processes started
  from inside the Claude desktop app on Windows, which is how Claude's test runs start;
  others report the same exit code only in that setup. CI runs on Linux.
- **Decided:** no config change, since none could be shown to help. `pool: "threads"` works
  here at the same speed, but a native crash there would end the whole run instead of one
  file. Revisit if it shows up in your own terminal or in CI.
