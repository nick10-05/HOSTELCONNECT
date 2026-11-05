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

## Day 6 — student complaints (2026-11-05)

Done when: a student files a text complaint within the limits and sees their list, and each
limit has a test. Met on the local database and checked in a browser; the code is live in
production (see "Deployment" below).

| Task | Who | Status | How verified |
|---|---|---|---|
| Migration 009 (`complaints`, `complaint_events`; the photo columns created now, unused until day 8) | Claude | Done | 13 database tests in `complaintsTable.test.ts`, run as `hostel_app`: every CHECK, the one-active-per-category index, and that the app cannot delete complaints or rewrite them or their events |
| Configurable limits (`COMPLAINT_MAX_ACTIVE`, `COMPLAINT_MAX_NEW_PER_DAY`, defaults 3 and 2) | Claude | Done | 2 tests in `config.test.ts` |
| The three limit checks and create (`createComplaint`) | Claude, at Nikhil's request (section 12 lists it under "You write"); stub, contract and tests first | Done | 19 tests in `complaints.test.ts`, three races of 5 rounds each included. The tests were checked against a throwaway reference: without the `FOR UPDATE` lock the two count races failed in 3 of 3 runs |
| List and detail with the ownership filter (`listMyComplaints`, `getMyComplaint`) | Claude, at Nikhil's request (also "You write"); stub, contract and tests first | Done | 11 tests in `myComplaints.test.ts`; with the `student_id` filter removed, both ownership tests failed |
| Can the student raise a complaint now (`getRaiseStatus`, `canRaise` on the list) | Claude (Nikhil's decision to add it) | Done | 7 service tests, one checking it agrees with `createComplaint` word for word; 3 route tests |
| Complaint routes and the per-IP limit | Claude | Done | 20 route tests in `complaintsRoutes.test.ts` on the real database: 401/403 for everyone but an active student, another student's complaint answered byte for byte like a missing one, each limit's 429, the per-IP limit. Two deliberate bugs (counting accepted requests; JavaScript string length) each failed a test |
| Student screens: My complaints, New complaint, complaint detail | Claude | Done | 19 screen tests and 3 `App` tests; checked in a browser as a student, desktop and phone width (below) |
| Dashboard complaints card | Claude | Done | 2 service tests, the route test, 3 screen tests; the card matched a direct count in the local database |

Checks at the end of the day: server 527 tests (450 on day 5), client 136 (111), typecheck and
builds clean.

Browser check (local dev servers and database, signed in as a fake student admitted for it):
filed a complaint (stored trimmed, `open`, `normal`, one `created` event by the student); the
form then showed Plumbing as already active, and a direct request for it got 429
`category_active`; after a second complaint the New complaint button was disabled with the
24-hour reason, and the form showed the reason instead; `/complaints/999` showed "That
complaint does not exist."; a student opening `/students` was sent home and the API answered
403. At 375 px wide nothing scrolls sideways. As the owner, the dashboard card read "2 active,
the oldest waiting under an hour", and the other owner pages loaded.

Found while building and fixed on the day:

- **Emoji and the 10-character minimum.** JavaScript counts an emoji as 2 characters and the
  database as 1, so five emoji would have passed the form and zod, then been refused by the
  database (a 500). The route, the form and its counter now count characters as the database
  does; a route test sends five emoji and expects 400.
- **The per-IP limit and shared Wi-Fi.** Students reach the server from the hostel's one
  public IP, so a plain per-IP limit would block real complaints, for example after a power
  cut. The limit now counts refused requests only (below).

### Decisions made on day 6

- **Photo columns now.** Migration 009 creates all five photo columns and their index, so day 8
  needs no migration; nothing writes them before day 8. A CHECK keeps a photo's path, size and
  expiry together, and only an existing photo can be marked deleted.
- **Description.** Trimmed first, then 10 to 500 characters, in zod, in the form and in the
  database. The database also requires the stored text to be trimmed (spaces, tabs and line
  breaks).
- **24 hours is a rolling window,** counting every complaint created in it whatever its status
  now, so a rejected one still counts.
- **Refusals.** All three limits answer 429 (section 5), checked in this order: one per
  category, then 3 active, then 2 in 24 hours. The messages name the limit and come from the
  configured numbers. A moved-out or unknown id is refused too (409 `student_inactive`, 404
  `student_not_found`), as in `transferStudent`.
- **Locking:** `createComplaint` locks the student's `users` row first, as every path that
  changes a student does, so two complaints sent at once cannot pass a limit together.
- **Per-IP limit:** 20 refused complaint requests per IP per 15 minutes (approved by Nikhil).
  Accepted complaints never count, so many students on one Wi-Fi are never blocked. Kept in
  memory like the other limits.
- **The student's list is newest first.** Section 5's order (active, high priority, oldest
  first) is the owner's list.
- **Day 6 routes are for students only;** the owner gets 403 until the owner's list and detail
  arrive on day 7.
- **`canRaise`** comes with `GET /api/complaints`: `allowed`, `reason` (the refusal
  `createComplaint` would give) and `activeCategories`. The button is disabled only for the
  two count limits; categories with an active complaint are shown as unavailable on the form,
  since the category is chosen there.
- **`POST /api/complaints` takes JSON on day 6;** it becomes multipart with the photo on day 8.
- **Dashboard card:** active complaints, high priority among them, and how long the oldest has
  waited. It counts moved-out students' complaints, since they still need an answer, and has
  no link until the owner's list exists (day 7).

### Notes for later days

- **Day 7, decide first:**
  - The design's diagram of the five legal status moves was not in the pasted text, so
    "reopen" is not defined yet. Section 4 says reopening needs a note, and migration 009 only
    enforces that rejecting needs one.
  - Revision 5 gives no maximum length for an owner's note. The database refuses only a blank
    note.
- **Day 7, build:**
  - `GET /api/complaints` and `/:id` choose the student or owner version by role.
  - The dashboard card links to the owner's list.
  - The service sets `updated_at` (there is no trigger) and `resolved_at` on every change.
  - Each status change or note notifies the student who raised it (`complaint_update`); never
    a phone number in the text.
- **Day 8:** the app role may already update `photo_deleted_at` and `photo_delete_attempts`.
  The create route switches to multipart.
- **Tests:**
  - Complaint tests that count across students use a snapshot (as in `dashboard.test.ts`).
  - Route tests build their own app, because all requests come from one IP and the per-IP
    limit would carry over between tests.
- **Local development data:**
  - The seeded students cannot log in: `SEED_STUDENT_PASSWORD` was not set when they were
    seeded, so they share a random password nobody knows.
  - For browser checks use "Complaint Tester" (`complaint.tester@example.com`, admitted on
    day 6; Nikhil chose the password and keeps it). They have two open complaints, #1 Plumbing
    and #2 Electrical, useful for day 7's owner screens.

### Deployment (2026-11-05, UTC)

| Step | Evidence |
|---|---|
| First unattended nightly backup | "Backup database" run #5 (schedule) at 01:43 on `main`: success, `hostelconnect-2026-11-05T0143Z.dump.age`, 31,838 bytes. Closes the open item from days 3 and 5 |
| Day 6 pushed on `day-6` | `3b02f19`, author nick10-05; 2 commits ahead of `main` |
| CI on `day-6` | Run #19 at 04:27: server and client green, every step (migrations 001–009 on an empty database, a second run changing nothing, tests, builds, dependency audit) |
| Backup before the migration | "Backup database" run #6 at 04:31 on `main`: `hostelconnect-2026-11-05T0432Z.dump.age`, 31,838 bytes (the same as run #5: production unchanged since), kept until 2027-02-03 |
| Migration 009 on production, before the merge | "Migrate production database" run #6 at 04:36 on `day-6` (`3b02f19`), success; 009 applied (per the run's log, as reported by Nikhil). Afterwards the live site, still on day 5 code, answered `/api/health` `ok` and `/api/dashboard` 401: 009 only adds tables |
| Review of `main..day-6` before the merge | 29 files, all under `server/`, `client/`, `docs/progress.md` and `.env.example`; no workflow, Dockerfile, package or lockfile changes; migrations 001–008 untouched; no secrets in added lines. Render needs no new setting (the limits default to 3 and 2) |

| Evidence above committed on `day-6` | `614a7f5`; CI run #20 green |
| `day-6` merged into `main` | Fast-forward `f258603..614a7f5`, pushed |
| CI on `main` | Run #21 green: server and client, every step |
| Render deploy | Serving day 6 from 04:45:57: `/api/health` answers `ok`; `GET /api/complaints`, `/api/complaints/1` and `/api/dashboard` answer 401 without a login (`/api/complaints` was 404 before); `POST /api/complaints` answers 401 without a login and 403 `cross_origin` from another site; an unknown `/api` path still 404; `/`, `/complaints/new` and `/complaints/1` serve the app; the served bundle contains the student screens and the dashboard card |
| Owner check | Signed in on production: the Dashboard shows Students (0 current students), Complaints ("None open.") and Rejoin requests ("None waiting."), in that order; `/api/dashboard` answered `complaints: { active: 0, highPriority: 0, oldestActiveAt: null }`; no console errors; nothing was submitted |

Day 6 is complete and live. Production still has no students, so the student screens cannot be
tried there; they were checked on the local database.

Not checked: the read-only schema query in the Supabase SQL Editor (tables, indexes, and that
`anon` and `authenticated` have no rights on `complaints`, `complaint_events`,
`rejoin_requests` and `notifications`). The live dashboard reading the `complaints` table
without an error shows migration 009 is in place; the rights check remains optional.

Signing in to production took several tries: production and the local database have separate
owner accounts with separate passwords (the production owner was created on day 3, see
`docs/deploy.md`, section 5), and the local password was tried first. There is still no tool to
reset the production owner's password; that belongs in the recovery guide on day 10.

## Day 7 — owner complaint workflow and announcements (2026-11-05)

Done when: the owner filters and sorts, sets priority, changes status and adds notes, the
student sees the timeline and a notification, and announcements publish, edit, pin, mark urgent
and delete. Core v1 is live. Met on the local database and checked in a browser as the owner and
as a student; not yet live (see "Deployment" below).

| Task | Who | Status | How verified |
|---|---|---|---|
| Transition map (`STATUS_MOVES`, `checkStatusChange`) | Nikhil (stub, contract and tests first) | Done | 33 table-driven tests in `complaintTransitions.test.ts`: all 16 status pairs, the note rules, 500 characters counted as the database counts them. Checked against a throwaway reference; counting with `note.length` failed 1 test, an extra rejected → open move failed 4 |
| Owner list query (`listOwnerComplaints`) | Nikhil (stub, contract and tests first) | Done | 9 tests in `ownerComplaints.test.ts`, each in a rolled-back snapshot: every filter, India's dates at both ends (00:10 India time is the new day), the three-level order, paging and totals, moved-out students. A UTC date failed 1 test, a building filter on any past stay failed 2, the order without "active first" failed 1 |
| Owner detail and the GET routes by role (`getOwnerComplaint`) | Claude | Done | 8 more tests in `ownerComplaints.test.ts` (with the current-stay condition removed, the moved-out test failed); 6 route tests: the owner's list and filters, 12 bad filters answering 400, the student's list unchanged, no phone numbers in any answer |
| Status change (`changeComplaintStatus`), an event write | Nikhil (stub, contract and tests first) | Done | 15 tests in `statusChange.test.ts`: each of the six moves (status, `updated_at`, `resolved_at`, one event, one notification), every refusal writing nothing, two races of 5 rounds each. Without the student-row lock the reopen race deadlocked (below); a note in the notification failed 6 tests; without `AND status = from` 2 failed |
| Owner note (`addComplaintNote`), an event write | Claude, at Nikhil's request (section 12 lists it under "You write"); stub, contract and tests first | Done | 14 tests in `complaintNotes.test.ts`: a note on each status touches only `updated_at`, one event, one notification without the note, 6 refusals writing nothing. An untrimmed note and a status reset each failed tests |
| Priority (`setComplaintPriority`) | Claude | Done | 9 tests in `complaintPriority.test.ts`, including that the student's list and detail are identical after a change. Also setting `updated_at` failed 7 |
| Write routes: `POST /:id/status`, `PATCH /:id` (priority only, strict), `POST /:id/notes` | Claude | Done | 13 route tests: 401, 403 for a student and for a temporary password, `cross_origin`, 404s, the services' messages passed through unchanged, `no-store`. Without the owner check a student's status change answered 200; a loose PATCH accepted `status` |
| Migration 010: note length, trimmed note, reopen needs a note; `announcements` | Claude | Done | 2 tests added to `complaintsTable.test.ts`, 5 in `announcementsTable.test.ts`, run as `hostel_app`. Without the reopen CHECK its test failed. Applied to the local database (a second run changed nothing) |
| Announcement fan-out and delete (`postAnnouncementInTransaction`, `deleteAnnouncementInTransaction`) | Claude, at Nikhil's request (also "You write"); stub, contract and tests first | Done | 8 of the 13 tests in `announcements.test.ts`, in rolled-back snapshots: one notification per active student, fixed text, none for moved-out students or the owner; delete matches the key exactly. Deleting with `LIKE` failed the exact-key test |
| Announcement edit and list, the transaction wrappers, the routes, `tests/helpers/rollbackDb.ts` | Claude | Done | 5 service tests (an edit that notified again failed 1); 13 route tests through the real app inside one rolled-back transaction; 3 tests of the helper itself. Without the owner check on DELETE a student could delete; a loose PATCH accepted unknown fields |
| Owner complaint screens: list with filters, detail with status, priority and note controls, shared timeline, dashboard link | Claude | Done | 32 client tests (timeline 4, list 9, detail 17, `App` 2); the student detail's tests unchanged. Reject without a note and `from` sent as the new status each failed tests |
| Announcement screens, the students' `/notices`, urgent and pinned notices on the student home, a student menu | Claude | Done | 23 client tests (owner page 11, notices 5, home box 3, `App` 4). A delete without confirmation and an Edit button on the students' page each failed tests |

Checks at the end of the day: server 670 tests (527 on day 6), client 191 (136), typecheck and
builds clean.

Browser check (local dev servers and database):

- Owner, complaints: the dashboard card's new link opened the list; the Electrical filter put
  `?category=electrical` in the address and left complaint #2. On #1, priority High, Start work
  with a note, then a note; the database had `in_progress`, `high`, three events, and two
  notifications for Complaint Tester with no body. Nothing scrolled sideways at 375 px.
- Student (Nikhil, as Complaint Tester): the bell showed 2 unread with the right titles and no
  note text, each opening #1; #1 showed In progress, no priority, the timeline with the owner's
  note, and no controls; #2 stayed Open.
- Announcements: an urgent, pinned test notice created 204 notifications for the 204 active
  students, one each, all "Urgent notice from the hostel.", none for the owner or a moved-out
  student. Editing the title and unpinning left the count at 204. Delete asked first, then
  removed the notice and all 204 notifications; Complaint Tester's two complaint notifications
  and the owner's three stayed. Nothing scrolled sideways at 375 px; no console errors from the
  finished code (the hot reload showed two errors while `App.tsx` was half edited).

Found while building and fixed on the day:

- **A deadlock between a reopen and a new complaint.** `createComplaint` holds the student's
  `users` row and waits on the one-active-per-category index, which the reopen's UPDATE holds;
  the reopen's `notify()` then needs a share lock on the same student row (the notification's
  foreign key). The race test found it ("deadlock detected", a 500). Every path that writes a
  complaint's timeline now locks the student row first, as `createComplaint` does; the race
  passes.
- **Route tests and the fan-out.** A committed announcement would notify the students other test
  files are checking at the same moment. `tests/helpers/rollbackDb.ts` runs the real app on one
  test connection, its transactions turned into savepoints, and everything is rolled back.
- **A cut-off `complaints.ts`.** A save from the editor left the file at 96 lines; it was rebuilt
  from the last commit plus the day's code, and the cut-off copy was kept outside the repository.
- **The Windows worker crash, captured.** One full run stopped with `Worker exited unexpectedly
  with exit code 3221226505` in `importStudents.test.ts`; that file passes on its own, and the
  next run passed in full (see "Known issue" under day 5).

### Decisions made on day 7

- **Six status moves, not five:** open → in progress, resolved or rejected; in progress →
  resolved or rejected; resolved → open ("reopen"). Rejected is final. Section 4 says "five legal
  moves" but also describes reopening; Nikhil chose to keep both.
- **Notes:** required to reject and to reopen; at most 500 characters, counted as the database
  counts them; stored trimmed. The database enforces all of it (009 and 010).
- **A status change sends the status the screen showed (`from`).** If it changed meanwhile, the
  answer is 409 `status_changed` and the page offers Reload.
- **Notification text is fixed:** "Your plumbing complaint is now in progress.", "There is a new
  note on your plumbing complaint.", "New notice from the hostel." or "Urgent notice from the
  hostel.", always without a body. A note or an announcement could contain a phone number, so its
  text never reaches a bell, and an edited announcement cannot leave old text there.
- **Priority stays invisible to students:** setting it changes no `updated_at`, writes no event
  and notifies no one. A note does move `updated_at`, and is allowed on any status.
- **Strict PATCH bodies:** priority only on a complaint; title, body, urgent and pinned only on an
  announcement. A status change is an action with its own route (section 5).
- **The owner list's building filter is `buildingId`,** as in the student directory, not section
  5's `building`. Only the default order is offered; section 5 names no other.
- **Announcements:** the body is required; DELETE answers 204; the confirmation is on the owner's
  screen (section 8). Urgent and pinned notices sit at the top of the student home (section 9),
  and students now have a menu (My complaints, Notices).
- **The dashboard's "Recent notices" card is left for later:** it is in section 9's dashboard but
  not in day 7's done-when.

### Notes for later days

- **Day 8:** the complaint photo (multipart create, the owner's countdown). The owner's detail
  page and the shared timeline are where it will show.
- **Day 10:** the owner's only notification type is the daily digest. The owner's three
  notifications in the local database are day 5 samples, all read, which is why the owner's bell
  shows no red count.
- **Tests:** anything that notifies `"active_students"` through the app runs on `rollbackDb`;
  every path that writes a complaint's timeline locks the student row first.
- **Still open, unchanged:** student password reset, the production owner-password tool, Aadhaar,
  helmet/CSP, backup retention, the Supabase certificate; and now the "Recent notices" card.
- **Local development data:** the local database is at migration 010. Complaint #1 is in
  progress, high priority, with two notes; Complaint Tester has two unread notifications; there
  are no announcements.

### Deployment

To be filled in during the deploy: backup on `main`, migration 010 on `day-7` before the merge,
CI, the review of `main..day-7`, the fast-forward, Render, and the live checks.
