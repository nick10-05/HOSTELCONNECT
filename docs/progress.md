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
- The day 10 job prunes notifications older than 60 days (this line said "day 8" until day 10);
  the owner's daily digest (day 10) includes pending rejoin requests.
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
as a student; live in production since 2026-11-05 (see "Deployment" below).

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

### Deployment (2026-11-05, UTC)

| Step | Evidence |
|---|---|
| Day 7 pushed on `day-7` | `35e1250` (code) and `7f90171` (this record), author nick10-05, no co-author line; 2 commits ahead of `main` |
| CI on `day-7` | Run #23 at 10:05 on `7f90171`: server and client green, every step (migrations 001–010 on an empty database, a second run changing nothing, tests, builds, dependency audit) |
| Backup before the migration | "Backup database" run #7 (id 42009212278) at 10:15 on `main` (`6c6b453`): `hostelconnect-2026-11-05T1015Z.dump.age`, 41,104 bytes, kept until 2027-02-03. Larger than run #6 (31,838 bytes) because #6 was taken before migration 009 |
| Migration 010 on production, before the merge | "Migrate production database" run #7 (id 42010331703) at 10:23 on `day-7` (`7f90171`), success, every step; per the run's log, as reported by Nikhil, 001–009 skipped and 010 applied. Checked beforehand: `main..day-7` adds only `010_notes_and_announcements.sql`, 001–009 unchanged. Afterwards the live site, still on day 6 code, answered `/api/health` 200 `ok`, `/api/dashboard` 401 and `/api/announcements` 404 |
| Review of `main..day-7` before the merge | 40 files, all under `server/src`, `server/tests`, `server/migrations`, `client/src` and `docs/progress.md`; no workflow, Dockerfile, package, lockfile, `.env.example` or `.nvmrc` changes; no new environment variables, so Render needs no new setting; no secrets or phone-like numbers in added lines |
| `day-7` merged into `main` | Fast-forward `6c6b453..7f90171` (`--ff-only`), pushed at 10:26:36 |
| CI on `main` | Run #24 on `7f90171`: server and client green (as reported by Nikhil from the Actions tab; the anonymous GitHub API limit was used up at the time) |
| Render deploy | Serving day 7 by 10:28:49: the served bundle is `index-Bh0e-DQ6.js`, the same build as locally, and contains the new screens. `/api/health` 200 `ok`; `/api/announcements` 401 without a login (404 before); `/api/dashboard`, `/api/complaints` and `/api/complaints/1` 401; the five new writes (status, priority, note, post and delete a notice) 401 without a login, and posting a notice or changing a status from another site 403 `cross_origin`; an unknown `/api` path still 404; `/`, `/complaints`, `/complaints/1`, `/announcements` and `/notices` serve the app |
| Owner check | Signed in on production (Nikhil signed in): the Dashboard's complaints card has the "Open complaints" link; the menu includes Complaints and Announcements; Complaints shows the filters (both buildings listed) and "No complaints yet."; Announcements shows the form and "No notices yet."; no console errors; nothing was submitted |

Day 7 is complete and live: core v1. Production still has no students, so nothing was posted or
changed there; the student side and the announcement fan-out were checked on the local database.

## Day 8 — photos, cost guard, food counts (2026-11-05 to 2026-11-06)

Done when: a compressed photo uploads, shows a countdown and is deleted by the job with retry;
uploads switch off at the threshold in a test; food counts match overall and per building. Met
on the local database against a separate Supabase development project, and checked in a browser
as the owner and as a student. One part is still open: rotating a real phone-camera photo (see
"Smoke test" below). Live in production since 2026-11-06 (see "Deployment" below).

| Task | Who | Status | How verified |
|---|---|---|---|
| Storage client (`lib/storage.ts`): upload, signed link, remove, plain `fetch` to the Storage REST API; a fake for tests (`tests/helpers/fakeStorage.ts`) | Claude | Done | 13 tests in `storage.test.ts`: random object names, only photo names sent to storage, a time limit on every request, remove says whether storage had the object, errors carrying the operation and status but never the key, a link or storage's text; 4 in `fakeStorage.test.ts` |
| Photo type by magic bytes (`lib/photoType.ts`) | Claude | Done | 2 tests in `photoType.test.ts`: JPEG, PNG and WebP accepted, anything else refused whatever its name or declared type |
| Settings: Supabase URL and secret key, bucket, the job secret, the limits | Claude | Done | 16 tests in `config.test.ts`: the URL must be https with no path, URL and key only together, all three secrets required in production, no value ever in an error message |
| Migration 011: `usage_counters` | Claude | Done | 4 tests in `usageCountersTable.test.ts`, run as `hostel_app`: the key format, no negative value, and the app role cannot delete a row or rename a key. Applied to the local database |
| Usage guard (`services/usage.ts`: `egressKey`, `getUsage`) | Claude, at Nikhil's request (section 12 lists it under "You write"); stub, contract and tests first | Done | 11 tests in `usage.test.ts`: India's calendar month for the counter, percentages rounded down, amber at 70%, uploads off at 85% of either limit, the failed-deletion count |
| Photo on `POST /api/complaints` (multipart through `photoUpload`, the photo step in `createComplaint`) | Claude | Done | 8 tests in `complaintPhoto.test.ts`: kept 48 hours, refused while uploads are off, the uploaded file removed again when the complaint cannot be saved, a 5-round race leaving no stray photo; 11 route tests in `complaintPhotoRoutes.test.ts`: over 1 MB refused before storing anything, the type decided from the bytes, refused while uploads are off, 503 when storage fails, `photoUploadsAllowed` on the student's list |
| Signed links (`issuePhotoLink`) and what each side sees (`photoView`, `studentPhotoView`) | Claude, at Nikhil's request (also "You write") | Done | 7 tests in `photoLink.test.ts`: the photo's size added to India's month only once storage issues the link, nothing counted on a storage failure, no link from the expiry time on, every view counted when many happen at once; 6 in `photoView.test.ts`; 7 in `complaintPhotoDetail.test.ts`: the owner gets `expiresAt` for the countdown, the student never does, `no-store` on both |
| Expiry job (`jobs/expirePhotos.ts`) | Claude, at Nikhil's request (also "You write") | Done | 9 tests in `expirePhotos.test.ts`: oldest first, at most 50, one transaction per photo with `FOR UPDATE SKIP LOCKED`, a failure only adds an attempt, "already gone" counts as deleted, two runs at once never take the same photo |
| `POST /api/internal/run-jobs` with `X-Job-Secret`; `.github/workflows/jobs.yml` (hourly, 7 minutes past) | Claude | Done | 9 tests in `jobsRoutes.test.ts`: 401 without or with a wrong secret (a login does not count), no endpoint when the secret is unset, a call from another site refused, 10 calls per 15 minutes, the secret never sent back. The workflow has not run yet; it is tried after the deployment |
| Food counts (`services/food.ts`: `getFoodCounts`) | Claude, at Nikhil's request (also "You write"); stub, contract and tests first | Done | 6 tests in `foodCounts.test.ts`: non-veg students counted as veg on their veg days, only stays covering the date, a mover only in the new building from the move day, a moved-out student on a date they still lived there, every building listed (empty ones with zeros) |
| `GET /api/food-counts?date=` (owner only, India's today by default) | Claude | Done | 4 tests in `foodCountsRoutes.test.ts`: owner only, India's today when no date is given, never cached, a date that is not a real date refused |
| Dashboard: the "Storage and bandwidth" card's data (`usage` on `GET /api/dashboard`) | Claude | Done | 4 tests in `dashboardRoutes.test.ts` |
| Screens: photo on the complaint form (compressed in the browser), the photo on both detail pages with the owner's countdown, the dashboard card, the Food counts page | Claude | Done | Client: `compressPhoto.test.ts` 9, `ComplaintPhoto.test.tsx` 9, `FoodCountsPage.test.tsx` 6, and new tests in the form, both detail pages, the dashboard and `client.test.ts` (FormData sent without a JSON header) |
| A flaky announcement test (`inSnapshot` in `tests/helpers/db.ts`) | Claude, fix approved by Nikhil | Done | Cause shown: another file's `SELECT ... FOR UPDATE` and UPDATE on a student, committed after a REPEATABLE READ snapshot, made the fan-out insert fail with 40001. `inSnapshot` now retries on 40001 (at most 3 tries); 5 tests in `inSnapshot.test.ts` |

New tests were checked to fail against planted bugs, then the code was restored and compared by
file hash. One planted bug can hide another, so where that happened each was rerun on its own.

Checks at the end of the day: server 786 tests (670 on day 7), client 231 (191), typecheck and
builds clean. One full server run stopped early with the known Windows worker crash (see day
5); the next run passed in full.

Browser check, food counts (local): for 2026-11-06 the page showed 117 veg and 87 non-veg, 204
in all, and for Tuesday 2026-11-10 123 and 81 (more students have veg days on Tuesday); an independent SQL count gave
the same numbers, overall and per building.

### Smoke test against the development project (2026-11-06)

Local servers and database, with a separate free Supabase project `hostelconnect-dev` (Data
API off) holding the private bucket `complaint-photos-dev`. Production was not touched. Scripts
printed counts and yes/no only, never the URL, the key or a link.

| Part | Result |
|---|---|
| Bucket | Upload, download through a signed link (same bytes), public address refused, changed token refused, remove `true`, remove again `false`, the old link refused after removal; the bucket empty afterwards |
| Upload | A local test student, "Photo Tester" (`photo.tester@example.com`, admitted on day 8 because the seeded students' password is unknown), sent #3 with a photo: stored as an 81,514-byte JPEG, 1600 × 900, no EXIF, `photo_expires_at` 48 hours after the complaint, the size in the database equal to the stored file |
| Viewing | The student saw the photo with no countdown and no `expiresAt`; the owner saw "Deleted in 47 h 47 min", matching the stored time. Each issued link added exactly 81,514 bytes to `egress:2026-11` (the dev build loads a page twice, so a page view issued two). A link was refused after 60 seconds (`InvalidJWT`, "exp" check failed), and the page then showed "The photo link has run out. Reload the page to see it again." |
| Dashboard | The card matched the database: 0.1 MB of 450 MB, 0.8 MB of 3,000 MB, "Photo uploads are on." |
| Expiry and retry | #3's `photo_expires_at` moved to the past on the local database only (Nikhil approved the UPDATE). A run with a wrong key: `{deleted: 0, failed: 1}`, one attempt, the file kept. A run with the right key: `{deleted: 1, failed: 0}`, `photo_deleted_at` set, the bucket empty, status and `updated_at` unchanged. A third run found nothing due. The owner's page then said "The photo has been deleted"; viewing it counted no bandwidth |
| Uploads off | With `EGRESS_LIMIT_MB=1` the card turned amber at 77% and #4 was still accepted with a photo; viewing it took the count to 93%: the card turned red with "Photo uploads are off … The bandwidth count starts again on 1 December 2026.", and the student's list answered `photoUploadsAllowed: false`. Restored to 3000 afterwards, and the card showed uploads on again |

Not checked live:

- **Rotation of a real phone-camera photo (open).** Both photos used were screenshots (no EXIF
  orientation), so turning a camera photo upright in the browser was not seen end to end. The
  canvas path is covered by `compressPhoto.test.ts` and a real-browser canvas check during the
  build (a 4000 × 3000, 6.8 MB JPEG came out 1600 × 1200, 237 KB).
- The student form's "Photos are switched off" line and the API's 409 `photo_uploads_off`: Photo
  Tester had reached two complaints in 24 hours, which hides the form first. Both are covered by
  tests.

### Decisions made on day 8

- **Storage:** a private bucket `complaint-photos`, created by Nikhil. Plain `fetch` to the
  Storage REST API, no Supabase library; multer, in memory, on the complaint create route only.
- **Secrets:** the Supabase secret key lives only in Render; `JOB_SECRET` in Render and in the
  GitHub environment "production". GitHub never gets the Supabase key. Production refuses to
  start without `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `JOB_SECRET`.
- **Development storage:** a separate Supabase project with its own key and bucket, never a key
  in the production project, because a secret key reaches every bucket of its project.
- **Limits:** `STORAGE_LIMIT_MB=450`, `EGRESS_LIMIT_MB=3000` (to be checked against Supabase's
  usage page), at most 1 MB per photo (the browser aims for about 500 KB), links valid 60
  seconds. Amber at 70%, uploads off at 85%, a warning after 5 failed deletions.
- **Bandwidth is an estimate:** every issued link adds the photo's size, counted in India's
  calendar month. The cut-off uses current usage, not counting the incoming photo.
- **Who sees what:** the student sees their own photo until it expires, without a countdown;
  the owner gets the countdown.
- **Expiry:** a photo storage no longer has counts as deleted; a failure only adds an attempt,
  and the job keeps trying every hour (the dashboard warns at 5). Only `expire-photos` runs on
  day 8.
- **Food counts:** for a chosen date, India's today by default; a stay counts on date d when
  `started_on <= d` and it has not ended by d (`ended_on IS NULL OR ended_on > d`); a non-veg
  student counts as veg on their veg days; the current food preference is used (there is no
  history). The route takes `date` only; the poll filter waits for day 9.

### Notes for later days

- **Production:** done (see "Deployment" below), except seeing the first "Run jobs" run answer
  200 with nothing due. A failed run makes GitHub email the repository owner.
- **Merging:** day 8 went in through a pull request as a merge commit; earlier days were
  fast-forwards. Agree which to use from day 9.
- **Rotation:** try one original phone-camera JPEG (copied as the original file, not through a
  chat app) when convenient.
- **Day 9:** the poll filter on food counts; fee rows and reminders join `run-jobs`.
- **Still open, unchanged:** student password reset, the production owner-password tool, Aadhaar,
  helmet/CSP, backup retention, the Supabase certificate, the "Recent notices" card.
- **Local development data:** the local database is at migration 011. Photo Tester (id 240) has
  #3 (photo deleted by the job) and #4 (photo kept until its 48 hours are up, in the development
  bucket). `egress:2026-11` is 978,168 bytes. The seeded students still cannot log in.

### Deployment (2026-11-06, UTC)

| Step | Evidence |
|---|---|
| Day 8 pushed on `day-8` | `a95d15c` (code) and `0a20041` (this record), author nick10-05, no co-author line; 2 commits ahead of `main` |
| CI on `day-8` | Run #27 at 13:10 on `0a20041`: green (as reported by Nikhil from the Actions tab) |
| Review of `main..day-8` before the migration | The only migration change is the new `011_usage_counters.sql`; 001–010 byte-for-byte unchanged. 011 only creates `usage_counters` (no existing table altered, no data touched), and the runner applies it in one transaction under its lock. `main` was the branch point, so a fast-forward was possible |
| Backup before the migration | "Backup database" run #9 (id 42224103619) at 13:15 on `main` (`66343f2`): `hostelconnect-2026-11-06T1316Z.dump.age`, 44,477 bytes, kept until 2027-02-04. Larger than run #7 (41,104 bytes), taken before migration 010 |
| Migration 011 on production, before the merge | "Migrate production database" run #8 (id 42224889175) at 13:21 on `day-8` (`0a20041`), success; per the run's log, as reported by Nikhil, 001–010 skipped and 011 applied |
| Settings before the merge (Nikhil) | Render: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (the production project's) and `JOB_SECRET`; `STORAGE_BUCKET` left unset, so the default `complaint-photos` applies. GitHub environment "production": the same `JOB_SECRET`. Production Supabase usage at the time: egress 0.001 GB, storage 0 GB |
| Merge into `main` | Through GitHub pull request #1, as merge commit `c6139b8` (parents `66343f2` and `0a20041`), not the fast-forward used on earlier days. Its file tree is identical to `day-8`'s, and it adds no other change |
| CI on `main` | Run #29 at 16:32 on `c6139b8`: green |
| Render deploy | `c6139b8` deployed (as reported by Nikhil). At 16:42: `/api/health` 200 `ok`; `POST /api/internal/run-jobs` without the secret 401 `invalid_job_secret`; `/api/food-counts` 401 without a login |
| Owner check | Signed in on production (Nikhil signed in): the dashboard's "Storage and bandwidth" card shows photo uploads on; nothing was submitted |
| "Run jobs" with the secret | Not yet seen: the workflow reached `main` with this merge and had no runs at 16:42; its first scheduled run is at 17:07 |

Day 8 is live. Production still has no students, so no photo was uploaded there; uploads,
links, expiry and the usage guard were checked against the development project (see "Smoke
test" above). Still open: the first "Run jobs" run answering 200, and rotation with a real
phone-camera photo.

## Day 9 — return poll and fees part 1 (2026-11-06 to 2026-11-07)

Done when: the owner runs a return poll and sees returned, not yet and no response; fee rows
follow each student's joining date; the owner can set UPI details and mark fees paid; students
see their balance and the UPI ID and QR. Met in tests on the local database. Live in production
since 2026-11-06 (see "Deployment" below); the screens have been seen there only partly, and
not at all locally (see "Notes for later days").

| Task | Who | Status | How verified |
|---|---|---|---|
| Migration 012: `return_polls`, `return_poll_responses`, `fees`, `hostel_settings` | Claude | Done | Run as `hostel_app`: 12 tests in `returnPollsTable.test.ts` (at most one open poll, the title rules, no delete, only the status and closing time may change), 10 in `feesTable.test.ts` (one row per student and due date, paid means a date and who recorded it, no delete), 8 in `hostelSettingsTable.test.ts` (one row, the UPI check, a QR image of at most 200 KB). Applied to the local database |
| Return polls (`services/returnPolls.ts`): start, close, answer, the owner's list, the student's open poll | Claude | Done | 17 tests in `returnPolls.test.ts`: starting notifies every active student, a second open poll is a 409, also when the database's one-open index is what refuses it (as with two starts at once), closing is final, an answer can change only while the poll is open (the poll row read `FOR SHARE`) |
| Poll results queries (`getPollCounts`, `getPollResults`) | Claude, at Nikhil's request (section 12 lists them under "You write"); stub, contract and tests first | Done | 13 tests in `returnPollResults.test.ts`: returned, not yet and no response among the students active now, by building, with each student's current building and room; a moved-out student drops off; the owner never appears |
| Return poll routes | Claude | Done | 18 tests in `returnPollsRoutes.test.ts` |
| Food counts by poll (`pollId`) | Claude | Done | 4 new tests in `foodCounts.test.ts` and 3 in `foodCountsRoutes.test.ts`: only the students who answered "returned" count; an unknown poll is a 404 |
| Fee row creation (`jobs/feeRows.ts`, in `POST /api/internal/run-jobs`) | Claude, at Nikhil's request (also "You write"); stub, contract and tests first | Done | 12 tests in `feeRows.test.ts`: one row per monthly due date counted from the joining date (clamped to the month's end), from `FEES_START_DATE` to 7 days ahead, every missed date caught up, the amount copied once, existing rows untouched, inactive students skipped; 4 new in `jobsRoutes.test.ts` (`feeRows: null` while the start date is unset); 2 new in `config.test.ts` |
| Balance calculation (`getMyFees`) and the owner's fees (`listFees`, mark paid or not paid) | Claude, at Nikhil's request (also "You write") | Done | 6 tests in `myFees.test.ts` (pending balance, overdue, "amount not set", next due date); 13 in `ownerFees.test.ts` (India's month, states, totals, filters, a payment date not after today, 409 when already in that state, the student notified on paid only); 14 route tests in `feesRoutes.test.ts` |
| Payment settings (`services/paymentSettings.ts`, `routes/settings.ts`) | Claude | Done | 9 tests in `paymentSettings.test.ts` (a UPI ID or a QR image must remain, a real change notifies every active student, saving the same details notifies nobody); 15 in `paymentSettingsRoutes.test.ts` (a QR over 200 KB is a 413, the type decided from the bytes, the image cached privately under an address that changes with each update). The complaint photo and the QR now share `middleware/fileUpload.ts` |
| Dashboard: the return poll and fees cards (`returnPoll`, `fees` on `GET /api/dashboard`) | Claude | Done | 4 new tests in `dashboard.test.ts`: no poll while none is open; due soon from today to 7 days ahead; overdue in any month; this month in India's calendar |
| Screens: Return polls and a poll's results, the student's poll tile, food counts by poll, Fees, My fees, Payment settings with the QR upload, the UPI QR for students, the two dashboard cards | Claude | Done | Client: `ReturnPollsPage` 7, `ReturnPollPage` 9, `ReturnPollTile` 5, `FeesPage` 14, `MyFeesPage` 10, `SettingsPage` 10, `prepareQr` 5, `PaymentQr` 8, `upiLink` 4, and new tests in `FoodCountsPage`, `DashboardPage` and `App` |

New tests were checked to fail against planted bugs, then the code was restored and compared by
file hash. One planted bug was not caught, and cannot be: which open poll the dashboard picks
when several are open, which the database never allows (`return_polls_one_open`).

Checks at the end of the day: server 950 tests (786 on day 8), client 317 (231), typecheck and
builds clean (client bundle 430 KB, 123 KB gzipped). Full server runs hit the known Windows
worker crash (see day 5); the file it stopped on passed when run alone.

### Decisions made on day 9

- **"You write" items:** Nikhil asked Claude to write all three (poll results queries, fee row
  creation, balance calculation), with the stub, contract and failing tests first.
- **Return polls:** at most one open at a time (a unique index; a second start is a 409), and
  closing is final. A poll covers every student active now, read live: "no response" is an
  active student with no answer, and a student who moves out drops off every poll, closed ones
  included. Answers can change while the poll is open. Starting one notifies every active
  student.
- **Fee rows:** one per monthly due date counted from the joining date (clamped to the month's
  end), created once due within 7 days, with every missed date caught up. The amount is the
  student's monthly fee at that moment and never changes afterwards; with no fee set it shows
  as "amount not set" and adds nothing to a total.
- **Go-live date:** `FEES_START_DATE`. No row is created for a due date before it, and none at
  all while it is unset. Production stays unset until the real register is imported, so earlier
  payments stay in the owner's record book.
- **Paid and not paid:** the payment date defaults to India's today and may not be after it, with
  an optional note of up to 200 characters. Marking paid notifies the student; marking it not
  paid again notifies nobody.
- **Payment details:** one row of settings, and a UPI ID or a QR image must remain. The QR image
  is at most 200 KB, its type decided from the bytes; the browser sends a small JPEG, PNG or
  WebP as it is and shrinks anything else. Without an image, students see a QR drawn in the
  browser from the UPI ID, including the amount to pay. A real change notifies every active
  student.
- **Jobs:** any failure in `run-jobs` answers 500, so GitHub emails about the failed run.

### Notes for later days

- **Browser check:** none yet for day 9's screens; to do with Nikhil signed in, locally and on
  production after the deployment.
- **Monthly fee:** there is no way yet to change a student's monthly fee after admission. Since
  amounts are fixed when a row is created, a student admitted without a fee gets "amount not
  set" rows. To decide.
- **A test race (fixed, tests only):** `jobsRoutes.test.ts` runs the photo expiry over the whole
  table with a 1999 clock, and `expirePhotos.test.ts`'s overlap test commits photos due in 1998.
  When the two files ran at the same moment, the jobs test claimed those photos inside its
  rolled-back transaction: the overlap test's runs skipped them (`FOR UPDATE SKIP LOCKED`), and
  after the rollback they stayed due, so later jobs tests counted them too (3 failures, as in CI
  run #32 on the pull request). A test advisory lock now keeps them apart (exclusive while the
  overlap test has committed photos, shared while a test runs the job; `tests/helpers/db.ts`),
  and the overlap test marks its own photos deleted if a round fails. Production code is
  unchanged.
- **"Run jobs":** answered 200 on its first run (manual, 19:32 UTC on 2026-11-06). Its hourly
  schedule had not fired by then (none at 17:07, 18:07 or 19:07); check that scheduled runs
  appear from now on.
- **Owner check, rest:** open the Fees and Payment settings pages on production.
- **Day 10:** reminders, the digest and pruning join `run-jobs`.
- **Still open, unchanged:** student password reset, the production owner-password tool, Aadhaar,
  helmet/CSP, backup retention, the Supabase certificate, the "Recent notices" card, rotation of
  a real phone-camera photo.

### Deployment

| Step | Evidence |
|---|---|
| Day 9 pushed on `day-9` | `070b593` to `f1f9511` (7 commits: code and this record), author nick10-05, no co-author line |
| CI on `day-9` | Run #31 at 18:55 on `f1f9511`: green |
| Review of `main..day-9` before the migration | The only migration change is the new `012_polls_fees_settings.sql`; 001–011 byte-for-byte unchanged. 012 only creates four tables and narrows `hostel_app`'s rights on them: no existing table altered, no data touched. The notification kinds it needs (`return_poll`, `payment_update`) were already allowed by 008. `main` is the branch point |
| Backup before the migration | "Backup database" run #10 (id 42275362757) at 18:57 on `main` (`37cb769`): `hostelconnect-2026-11-06T1858Z.dump.age`, 45,851 bytes, kept until 2027-02-04. Larger than run #9 (44,477 bytes), taken before migration 011 |
| Migration 012 on production, before the merge | "Migrate production database" run #9 (id 42275730978) at 19:00 on `day-9` (`f1f9511`), success; per the run's log, as reported by Nikhil, 001–011 skipped and 012 applied |
| Settings before the merge | None needed: `FEES_START_DATE` stays unset in production for now |
| CI on the pull request | Run #32 on `f1f9511` failed: the photo-expiry test race (see "Notes for later days"). Fixed in `f15100a` (tests only), pushed; runs #33 (push) and #34 (pull request) on `f15100a` green |
| Merge into `main` | Through GitHub pull request #2, as merge commit `370c3bb` (parents `37cb769` and `f15100a`). Its file tree is identical to `day-9`'s |
| CI on `main` | Run #35 at 19:16 on `370c3bb`: green |
| Render deploy | Serving day 9 by 19:20: the served bundle is `index-WR1bvl9H.js`, the same build as locally. `/api/health` 200 `ok`; `/api/fees`, `/api/fees/mine`, `/api/return-polls`, `/api/return-polls/mine`, `/api/settings/payment`, `/api/settings/payment/qr` and `/api/food-counts?pollId=1` 401 without a login; saving payment settings or a fee's status from another site 403 `cross_origin`; `run-jobs` without the secret 401; an unknown `/api` path 404; `/fees`, `/return-polls`, `/return-polls/1` and `/settings` serve the app |
| Owner check | Signed in on production (Nikhil signed in; as reported by him): the dashboard loads, the Return poll card says "No poll open." and the Fees card "No fees pending."; the owner menu includes Return polls, Fees and Settings. The Fees and Payment settings pages themselves not opened yet; nothing was submitted |
| "Run jobs" with the secret | No runs at all by 19:23: none scheduled (17:07, 18:07, 19:07) and a first manual try did not start. Then "Run jobs" run #1 (id 42280462858) at 19:32 on `main` (`bf899b3`), started by hand, success; per the run's log, as reported by Nikhil, `Status 200: {"expirePhotos":{"deleted":0,"failed":0},"feeRows":null}` (`feeRows` is null because `FEES_START_DATE` is unset) |
| CI on `main` after this record's first part | Run #38 on `bf899b3` (pull request #3, merge commit of `day-9-record`): green |

## Day 10 — fees part 2, recovery guide, README (2026-11-07)

Done when: reminders appear once each and the daily digest works; `docs/RECOVERY.md` is
written and a second restore drill passes on seeded data; the README has screenshots and an
architecture diagram; you can demo and explain it in 2 minutes. So far: reminders, the digest
and the recovery guide are met in tests on the local database; both restore drills with the
real key passed (seeded data and the newest production backup); the README has its diagrams
and four screenshots. Deployed on 2026-11-07 and checked with a "Run jobs" run (see
"Deployment" below).

| Task | Who | Status | How verified |
|---|---|---|---|
| Fee reminders (`jobs/feeReminders.ts`) | Claude, at Nikhil's request (section 12 lists "reminder timing" under "You write"); stub, contract and tests first | Done | 29 tests in `feeReminders.test.ts`: every day from 30 before to 60 after a due date gives the right stage or none; one reminder per fee and stage over a fee's whole life, also when runs come late; the days left in the title; nothing for a paid fee, a fee of ₹0 or a moved-out student; "Your fee" with no amount; Indian grouping (₹1,25,000); each pending fee separately |
| The owner's daily digest (`jobs/digest.ts`) and `hostelHour` (`lib/dates.ts`) | Claude, at Nikhil's request ("digest content" is also "You write"); stub, contract and tests first | Done | 15 tests in `digest.test.ts`: the four counts by the dashboard's rules (compared before and after each test's own rows, in one snapshot), the text naming only counts that are not zero, nothing before 8 am India time, one per day by India's date, none for an inactive owner or a student; 1 in `dates.test.ts` |
| Pruning (`jobs/pruneNotifications.ts`) | Claude | Done | 4 tests in `pruneNotifications.test.ts`: more than 60 days old goes, read or not, everyone's; exactly 60 days stays |
| The three jobs in `POST /api/internal/run-jobs`, after photos and fee rows | Claude | Done | 5 new tests in `jobsRoutes.test.ts` (a fee row reminded in the call that created it, reminders without `FEES_START_DATE`, the digest at 08:30 and not at 07:00, pruning by the app's clock); the existing ones now expect `feeReminders`, `digest` and `pruned` in the answer |
| Production owner-password reset (`reset-owner-password --production`) | Claude | Done | 5 new tests in `resetOwnerPassword.test.ts` (`resetTargetProblem`, `confirmationMatches`). By hand with fake URLs only, every run exiting 1: no `DATABASE_URL` in the window (`.env` ignored), a local URL with `--production`, another machine's URL without it, a wrong or empty retyped email, and the right one (which then tried to connect and failed on the fake host). Not run against production |
| `docs/RECOVERY.md` | Claude | Done | Every script, file and option it names exists. The seeded-data drill (section 9) rehearsed end to end with a throwaway key, since deleted: the local database (215 users, 217 stays, 104 beds, migration 012) dumped as the nightly backup does, encrypted, restored by `ops/restore-drill.sh`, "Drill passed" |
| README: the problem, features, architecture (two Mermaid diagrams), stack, security, running it locally | Claude | Done | Facts checked against the code (16 tables, 60-second photo links, the `_test` database, the `/api` proxy); "installable as a PWA" removed, as there is no manifest yet; "password resets" removed from the owner's list, as students' passwords cannot be reset yet. The diagrams have not been seen rendered |
| Screenshots for the README (`docs/screenshots/`: owner dashboard, owner complaints, student home, student fees) | Nikhil | Done | Taken from the local database only. A fake "Demo Student" was admitted locally; its joining date was corrected to 2025-01-14 in the local database (there is no edit screen), and its fee rows (14 Sep, 14 Oct, 14 Nov 2026, ₹6,500 each) came from a local `run-jobs` call with `FEES_START_DATE=2026-09-01`. A demo UPI ID (`hostelconnect.demo@upi`), an urgent notice and a return poll were set up locally. All four checked by Claude: fake names and the demo UPI ID only, no phone numbers or emails |
| Restore drill on seeded data, with the real key | Nikhil (needs the private key) | Passed (2026-11-07) | `docs/RECOVERY.md` section 9: the local database dumped as the nightly backup does, encrypted to the real key, restored by `ops/restore-drill.sh`, "Drill passed". Row counts not recorded |
| Restore drill on the newest production backup, `hostelconnect-2026-11-07T0105Z.dump.age` | Nikhil | Passed (2026-11-07) | "Drill passed"; users 2, stays 2, 12 migrations, the last `012_polls_fees_settings.sql` (the newest file in `server/migrations/`); `restore_drill` dropped and the downloaded backup deleted. Expected 1 user; the second was a test student, since moved out (see "Notes for later days") |
| "Decisions and trade-offs" write-up, in his own words (`docs/decisions.md`) | Nikhil; Claude made the headings and added his points at his request | Done | Eight sections and "How it was built". Claude checked the facts against the code (the security measures, the bed index `stays_one_current_per_bed`, the test counts) and corrected, with his approval: that the owner cannot reset a student's password either, that Nikhil (not the owner) restores backups, that complaint photos are not backed up, and that planted bugs were per piece of work, not one per test |

New tests were checked to fail against planted bugs, then the code was restored. Not caught:
including moved-out students in the reminders query, or inactive owners in the digest, as
`notify()` already skips inactive people (the filters only save work); and taking the
digest's day from UTC instead of India, which cannot differ from 8 am India time onwards
(02:30 UTC).

Checks: server 1009 tests (950 on day 9), client 317 (unchanged), typecheck clean. Full
server runs still hit the known Windows worker crash now and then (see day 5). One full run
also failed 2 tests in `jobsRoutes.test.ts` (the photo count it expected), alongside a worker
crash; it did not come back in the next 10 full runs. Probably a crashed worker leaving the
photo-expiry race test's photos committed; not proven.

### Decisions made on day 10

- **"You write" items:** Nikhil asked Claude to write both (reminder timing, digest content),
  stub, contract and failing tests first. The "decisions and trade-offs" write-up stays his.
- **Reminder windows:** "before" from 3 to 1 days before the due date, "due" from the due date
  to 2 days after, "overdue" from 3 to 9 days after, each once per fee (key
  `fee:<fee id>:<stage>`). A late run still sends the stage for its own day, never an earlier
  one it missed. The windows are closed because pruning deletes the dedup keys after 60 days.
- **Reminders:** pending fees of active students only, none for a fee of ₹0, "Your fee" when
  no amount is set. They run without `FEES_START_DATE` too, since they only look at existing
  rows (none exist in production yet).
- **Digest:** from 8 am India time, once a day per active owner (key `digest:<date>`), counted
  as the dashboard counts. Nothing when all four counts are zero; a day that was all zeros at
  8 am still gets one from a later run that day if something becomes pending.
- **Pruning:** notifications more than 60 days old, read or not.
- **Production owner reset:** a `--production` flag on the existing laptop script, not a
  workflow, whose log anyone could read in this public repository. `DATABASE_URL` comes from
  the window only, the database must be on another machine, and the owner's email is typed
  again first.
- **GitHub's schedule, accepted for now:** "Run jobs" ran on schedule only twice in about
  9 hours (#2 at 21:59 and #3 at 01:45 UTC, both green), and backup run #11 started at 01:05
  UTC instead of 21:30. Reminders tolerate gaps of days; the digest may come late in the day
  and photos may outlive their 48 hours by some hours (no link is issued after them). No
  external cron for now (it would hold `JOB_SECRET` in one more account); watch for a week.

### Notes for later days

- **Correction:** the day 5 notes said "the day 8 job prunes notifications". Pruning was
  added on day 10.
- **Correction:** the first versions of the README and `docs/RECOVERY.md` (this branch)
  said the owner can reset a student's password in the app. No such action or endpoint
  exists (`POST /api/students/:id/reset-password` in design doc section 5 was never built);
  both now say so.
- **Also missing, found while taking the screenshots:** editing a student's details after
  admission (`PATCH /api/students/:id`, design doc section 5). Neither the route nor a
  screen exists, so a wrong joining date or monthly fee can only be fixed in the database.
- **Seen in the screenshots:** the student's fee list writes September as "Sept" (the
  browser's date format); the server's reminder text writes "Sep".
- **Second production user: a test student, now moved out.** The production backup of
  2026-11-07 01:05 UTC has 2 users where the records expect only the owner (made on day 3;
  "no students yet" up to day 8). No script can have made it: `seed:owner` refuses a second
  owner, and `import-students` and `seed:students` refuse any database not on this machine.
  Only an admission, a transfer or a reactivation in the app inserts stays, always for a
  student, and the backup has 2. On 2026-11-07 Nikhil signed in to production as the owner:
  Students listed one current student, which he identified as a test account, not a resident.
  He moved it out in the app the same day (no deletes: the app cannot delete students, and
  `hostel_app` has no `DELETE` on users or stays). It now appears under Former students and
  can no longer log in. When and how it was admitted, and what its two stays were, was not
  recorded. Production was not queried; no data was changed except by that move-out.
- **Rule: test admissions happen only in the local database.** Never admit, import or seed
  test students in production, not even to try a screen after a deploy. Production checks are
  read-only (pages load, counts look right) unless the owner is doing real work. This repeats
  the standing rule; the test student above broke it.
- **Before the merge:** nothing left. No migration, so no backup-then-migrate step; no new
  Render or GitHub settings.
- **After the merge:** done; "Run jobs" run #4 answered 200 with `feeReminders`, `digest`
  and `pruned` (see "Deployment"). Still to see: the owner's first digest, on a morning when
  something is pending.
- **Still open, unchanged:** changing a student's monthly fee after admission, a full browser
  check of the day 9 screens (the screenshots covered the dashboard cards, the poll tile and
  My fees locally), opening the Fees and Payment settings pages on production, student
  password reset, Aadhaar, helmet/CSP, the Supabase certificate, the "Recent notices" card,
  rotation of a real phone-camera photo, a PWA manifest.

### Deployment (2026-11-07, UTC)

| Step | Evidence |
|---|---|
| Day 10 pushed on `day-10` | `dedea31` to `0aa0270` (9 commits: code, docs and this record), author nick10-05, no co-author line |
| CI on `day-10` | Runs #42 to #46, one per push, the last on `0aa0270`: green |
| Before the merge | No migration, so no backup-then-migrate step; no new Render or GitHub settings |
| Merge into `main` | Through GitHub pull request #5, as merge commit `f145494`, merged by Nikhil |
| CI on `main` | Run #48 at 07:23 on `f145494`: green |
| Health | `/api/health` 200 `ok` at 07:24 (this alone does not show which version is served) |
| "Run jobs" with the secret | Run #4 (id 42351315267) on `main` (`f145494`), started by hand, success. Per the run's log, as reported by Nikhil: `Status 200` with `expirePhotos`, `feeReminders`, `digest` and `pruned`, so the day 10 code is live |

## After the plan: student password reset (2026-11-07)

The first item of `docs/decisions.md` section 8: a student who forgot their password had no
way back in, and the owner could not reset it (design doc section 5 planned
`POST /api/students/:id/reset-password`; the day 10 notes found it missing). Branch
`student-password-reset`, from `main` at `825982e`.

| Task | Who | Status | How verified |
|---|---|---|---|
| `resetStudentPassword` (`services/students.ts`) | Nikhil, against Claude's stub, contract and tests | Done | 7 tests in `resetStudentPassword.test.ts`: the new password works and the old one does not, stored hashed, `must_change_password` set, nothing else on the account changes; also for a student who never changed their first password; a different password each time, only the latest works; only that student changes; 404 for an unknown id and for the owner's id; 409 for a former student, changing nothing |
| Review fix | Claude, with Nikhil's approval | Done | If the `UPDATE` changed no row but the follow-up `SELECT` found an active student (reactivated between the two), the function returned a password that was never saved. It now answers 409 `student_inactive` ("This student changed just now. Try again."). Not tested: it needs two connections timed exactly |
| `POST /api/students/:id/reset-password` | Claude | Done | 5 tests in `studentsRoutes.test.ts` (owner only, the answer with `Cache-Control: no-store`, a bad id, the service's refusal, a cross-site request) and 1 end-to-end test in `resetPasswordFlow.test.ts` against the real database: the old password fails at once, an open session is held with `password_change_required`, the temporary password must be changed first, then everything works again; still active in the same bed |
| Profile: **Reset password** for current students (`ResetPasswordConfirm.tsx`) | Claude | Done | 5 tests in `StudentProfilePage.test.tsx` (current students only, Cancel sends nothing, the password shown once and forgotten on Done, a refusal shown). In the local browser on the fake Demo Student: the question, `200`, the temporary password, Done |
| README, `docs/RECOVERY.md` section 6 | Claude | Done | Both now say the owner resets a student's password from the profile |

New tests were checked to fail against planted bugs, then the code was restored: in the
service, not setting `must_change_password`, any role, former students too, storing the plain
password, changing another column, updating other students; in the route, no `no-store`, no
owner check; on the profile, the button for former students. Each failed at least one test.

Checks: server 1022 tests (1009 before), client 322 (317 before), typecheck clean. No
migration and no new settings.

### Decisions

- **Who writes:** Nikhil wrote the service function; Claude the stub, contract, tests, route,
  screen and docs.
- **Active students only:** a former student cannot log in anyway, and reactivation already
  gives a new temporary password.
- **No notification** to the student (they cannot log in to read it); open sessions are not
  ended but held at the change-password screen, since `requireAuth` reads
  `must_change_password` on every request.

### Notes for later days

- After a reset the profile shows "Has not logged in yet" (the badge follows
  `must_change_password`), and the note under the temporary password says "when they first
  log in". Both are worded for a new admission. Fixed afterwards on branch `reset-wording`:
  the badge now says "Must change password" and the note "when they next log in", which fit
  an admission, a reactivation and a reset alike.
- `docs/decisions.md` section 8 still lists this as not built (Nikhil's write-up).
- Deployed on 2026-11-07 (see "Deployment" below).

### Deployment (2026-11-07, UTC)

| Step | Evidence |
|---|---|
| Pushed on `student-password-reset` | `f204f0e` (code) and `e1b8d05` (docs), author nick10-05, no co-author line |
| CI on the branch | Run #58 on `e1b8d05`: green |
| Before the merge | No migration, so no backup-then-migrate step; no new Render or GitHub settings |
| Merge into `main` | Through GitHub pull request #9, as merge commit `c2fb446`, merged by Nikhil |
| CI on `main` | Run #60 on `c2fb446`: green at 08:23 |
| Live site | `/api/health` 200. `POST /api/students/1/reset-password` without a login answers 401, where a path the app does not have answers 404, so the new route is served. No student's data was touched: the login check refused it first |
| Owner check | Not done yet: the Reset password button on a current student's profile in production (look only, do not click it on a real student) |

## After the plan: editing a student's details and monthly fee (2026-11-07)

The second item of `docs/decisions.md` section 8: a wrong detail or monthly fee after
admission could only be fixed in the database (the day 10 notes found
`PATCH /api/students/:id`, design doc section 5, missing). Branch `edit-student`, from
`main` at `77b63bc`.

| Task | Who | Status | How verified |
|---|---|---|---|
| `updateStudent` (`services/students.ts`) | Claude, at Nikhil's request, against the stub, contract and tests written first | Done | 10 tests in `updateStudent.test.ts`: every detail saved and nothing else on the account; the old category's fields cleared; stays and existing fee rows unchanged; the student's own email accepted in any letter case; another account's email refused (409 `email_taken`), changing nothing; a former student's details corrected when the fee stays the same; a former student's fee refused (409 `student_inactive`), changing nothing; only that student changes; 404 for an unknown id and for the owner's id |
| `PATCH /api/students/:id` | Claude | Done | Tests in `studentsRoutes.test.ts` (owner only; the cleaned details saved and the profile sent back with `Cache-Control: no-store`; a missing fee as not set; bad input refused, including a joining date or place; a bad id; the service's refusal; a cross-site request) and 1 end-to-end test in `editStudentFlow.test.ts` against the real database |
| Profile: **Edit details** for current and former students (`EditStudentForm.tsx`) | Claude | Done | 6 tests in `StudentProfilePage.test.tsx` (offered to both; filled with the stored details, the joining date read-only, Cancel sends nothing; saving shows the server's profile and closes the form; the fields checked before sending; a refusal shown with the form kept; a former student's fee shown but not editable). In the local browser on the fake Demo Student: Non-Veg with a Tuesday veg day saved (`200`, "Details saved.", the profile updated), then set back to Veg |
| README | Claude | Done | Editing moved from "Not built yet" to the students' features |

A planted bug in the form (sending the request after the field checks failed) first passed
the client tests; the tests were strengthened to count requests and then caught it.

Checks: server 1046 tests (1022 before), client 328 (322 before), typecheck clean. No
migration and no new settings.

### Decisions

- **Who writes:** Claude wrote the service function as well, at Nikhil's request.
- **A new fee applies to future fee rows only:** each fee row copies `monthly_fee` when it
  is created, so rows already listed keep their amount; the form says so.
- **The joining date cannot be edited.** Migration 007 lets the app role change only where a
  stay ends and its place, never `started_on`, by design. Changing it would need a
  migration and rules for fee rows already created; left out for now.
- **Former students:** their details can be corrected, but their fee cannot change.

### Notes for later days

- `docs/decisions.md` section 8 still lists this as not built (Nikhil's write-up).
- The day 10 note above ("Also missing … editing a student's details") is now built, except
  the joining date.
- Deployed on 2026-11-07 (see "Deployment" below).

### Deployment (2026-11-07, UTC)

| Step | Evidence |
|---|---|
| Pushed on `edit-student` | `6073fe9` (code) and `d19a286` (docs), author nick10-05, no co-author line |
| CI on the branch | Run #67 on `d19a286`: green |
| Before the merge | No migration, so no backup-then-migrate step; no new Render or GitHub settings |
| Merge into `main` | Through GitHub pull request #12, as merge commit `00eb601`, merged by Nikhil |
| CI on `main` | Run #69 on `00eb601`: green at 09:14 |
| Live site | `/api/health` 200. `PATCH /api/students/1` without a login answers 401, where a path the app does not have answers 404, so the new route is served. No student's data was touched: the login check refused it first |
| Owner check | Not done yet: the Edit details and Reset password buttons on a current student's profile in production (look only, do not save or click on a real student) |

## UI/UX redesign (2026-11-07)

Every owner and student page, form, detail view and the sign-in pages, redesigned on the
branch `redesign-foundations`. UI only: no API, server or database change.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Design tokens, fonts, icons (`index.css`, `ui/icons.tsx`) | Claude | Done | Light "Aurora" and dark "Midnight" tokens; self-hosted Inter and Plus Jakarta Sans; own line icons, no icon library |
| Shared parts (`client/src/ui/`) | Claude | Done | Buttons, cards, pills, skeletons, empty states, page header, pager, filter panel, segmented control, avatars, bottom sheet, toast, sign-in frame; tests in `ui.test.tsx`, `listParts.test.tsx`, `overlays.test.tsx` |
| App frame | Claude | Done | Glass top bar; floating tab bar on phones (Home, Students, Complaints, Fees, More) and a sidebar from `md`; the rest of the owner's pages in a "More pages" sheet |
| Owner pages | Claude | Done | Dashboard (occupancy ring, needs-attention list, quick actions), Students, Complaints, Fees, profiles, complaint detail, Buildings, Admit, Rejoin requests, Announcements, Return polls, Food counts, Settings |
| Student pages and sign-in | Claude | Done | New home with a greeting, notices, the return poll, complaints and a fees card; complaint form and detail, notices, fees; sign in, request access, choose a password |
| Dark mode and the switch (`ui/theme.tsx`) | Claude | Done | Follows the phone by default; Automatic, Light or Dark in the top bar, kept in `localStorage` (`hc-theme`) on that device only and applied before the first paint by a small script in `index.html`; 11 tests in `theme.test.tsx` |
| Loading, accessibility | Claude | Done | Shimmer placeholders replace every "Loading…" (screen readers still hear a label); every button and link at least 44px tall; reduced motion respected |
| README | Claude | Done | "Look and feel" paragraph; `ui/` in the layout |

Checks: client 378 tests (367 before the switch, 328 before the redesign), typecheck clean,
build clean. In the local browser at 375px wide, all 14 owner pages measured in light and
dark: no text below WCAG AA contrast (4.5:1, 3:1 for large text), no tap target under 44px,
no sideways scrolling, no console errors. The student and sign-in pages were measured the
same way through a temporary page with made-up data (deleted afterwards), because the local
browser is signed in as the owner.

### Notes for later days

- README screenshots retaken by Nikhil after the deployment (owner pages in light at
  laptop width, student pages in dark at phone size, local demo data).
- Not checked on a real phone yet (only the browser's phone-size view).
- Deployed on 2026-11-07 (see "Deployment" below).

### Deployment (2026-11-07, UTC)

| Step | Evidence |
|---|---|
| Pushed on `redesign-foundations` | `202a686` (code) and `c38132a` (docs), author nick10-05, no co-author line |
| Before the merge | No migration, so no backup-then-migrate step; no new Render or GitHub settings |
| Merge into `main` | Through GitHub pull request #14, as merge commit `250c4e9` at 11:54, opened and merged by Nikhil |
| CI on `main` | Run #75 on `250c4e9`: green (1 min 12 s) |
| Live site | `/api/health` answers `{"status":"ok"}`; the page now carries the light/dark script from `index.html` (`hc-theme`), which the earlier build did not have, so the new client is served. Checked with plain requests only: no login, no data touched |
| Owner check | Not done yet: the owner looks at the live site on a phone, in light and dark, and tries the Automatic/Light/Dark switch |

## Content Security Policy and security headers (2026-11-07)

The live site sent no browser security headers. Now every response (the page, its files,
the API and error answers) carries them, from `server/src/middleware/securityHeaders.ts`,
mounted first in `app.ts`.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Light/dark script moved out of `index.html` into `client/public/theme-init.js` | Claude | Done | The only inline script, so `script-src 'self'` needs no `unsafe-inline`; `client/src/indexHtml.test.ts` (3 tests) keeps `index.html` free of inline scripts and handlers |
| Fonts never inlined (`vite.config.ts`, `assetsInlineLimit`) | Claude | Done | Vite had turned one 1.7 KB font subset into a `data:` URL, which `font-src 'self'` blocked in the browser check; now 0 `data:` URLs in the built CSS |
| Headers middleware and tests | Claude | Done | `default-src`, `script-src`, `style-src`, `font-src`, `connect-src` `'self'`; `img-src 'self' data:` plus the Supabase origin for complaint photos; `object-src` and `base-uri 'none'`; `frame-ancestors 'none'`; plus `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, COOP, a Permissions-Policy, and HSTS in production only; 16 tests in `securityHeaders.test.ts` |
| `CSP_REPORT_ONLY` setting (`config.ts`) | Claude | Done | `true` sends the same policy as `Content-Security-Policy-Report-Only`; anything else (or unset) enforces; test in `config.test.ts` |

Checks: server 1074 tests and client 381 tests pass, both typechecks clean, client build
clean. In the local browser, the production build was served with exactly these headers
(enforced, not report-only) and all 14 owner pages visited: no CSP violations after the font
fix, the Settings QR (`data:` image) shows, and a saved dark choice is applied from
`theme-init.js` before the first paint.

### Notes for later days

- Not checked locally: complaint photos from the Supabase origin (the local setup has no
  bucket) and the student pages. Check both on the live site during the report-only trial.
- Rollout: deploy with `CSP_REPORT_ONLY=true` set in Render, check the live site's console,
  then delete the setting to enforce. No code change is needed to switch.

### Deployment (2026-11-07)

| Step | Evidence |
|---|---|
| Merge into `main` | Through GitHub pull request #15, as merge commit `2ac5d2b`, merged by Nikhil |
| Enforced | The live page answers with `Content-Security-Policy` (not the report-only header), allowing images from the Supabase project's origin, plus HSTS, `nosniff`, `X-Frame-Options: DENY`, COOP and the Permissions-Policy. Checked with plain requests, no login |
| Owner check | Production testing done by Nikhil, including his phone in light and dark |

## Multi-tenant SaaS, phase 1: hostels in the schema (2026-11-07)

HostelConnect becomes a platform for any hostel (decisions in `docs/decisions.md`, section
9). Phase 1 is the "expand" step: migration `013_hostels.sql` adds hostels to the schema
without changing what today's code does. Nothing is moved or deleted; every existing row
becomes part of hostel #1.

| Part | Who | Status | Evidence |
|---|---|---|---|
| `hostels` table | Claude, at Nikhil's request | Done | Name, slug (for `/h/<slug>/login`, 3–40 lowercase letters, digits and single hyphens), status (active or suspended), the beta limits (300 students, 20 buildings), a per-hostel fee start date. Hostel #1, "HostelConnect", holds today's data. The app may create a hostel (name and slug only) and rename it; only the platform admin sets status and limits; the app can never delete one |
| `hostel_id` on 15 tables | Claude | Done | `bigint NOT NULL DEFAULT 1`, so rows written by today's code land in hostel #1. `usage_counters` stays platform-wide until phase 5 |
| No row points into another hostel | Claude | Done | Composite foreign keys on `(hostel_id, …)` from every row to its building, room, student, author, complaint or poll |
| No row changes hostel | Claude | Done | The `hostel_id_fixed` trigger on all 15 tables |
| Per-hostel unique rules | Claude | Done | Email, building name, one open poll and payment settings per hostel, next to today's global indexes, which phase 6 drops |
| Google sign-in columns | Claude | Done | `users.google_sub` (owners only, unique); an owner with a Google account may have no password; students always have one |
| Tests | Claude | Done | `tests/tenancyTables.test.ts`, 24 tests, written first and seen failing before the migration existed |

Checks: server 1098 tests (1074 before) and typecheck clean. Rehearsal on a copy of the
local demo database (104 users, 860 notifications, 217 fees), restored the way the restore
drill restores a backup: 013 applied, every table kept its row count, every row in hostel
#1, every new constraint validated; the copy was dropped afterwards.

### Notes for later days

- Moved to phase 2: "one owner per hostel". The tests create owners freely (`insertOwner`
  in 301 places, often several in one test), so the rule waits until every test has its
  own hostel.
- Before merging: the same rehearsal on a restored production backup (restore drill with
  `--keep`), then a backup and the Migrate workflow as for every migration.

## Multi-tenant SaaS, phase 2a: hostel context and sign-in lookups (2026-11-07)

Phase 2 makes each hostel's data invisible to every other hostel, in four steps: 2a the
hostel context, 2b every query scoped, 2c the two-hostel isolation tests, 2d row-level
security. 2a lays the ground; what the app does does not change, since every account is
still in hostel #1.

| Part | Who | Status | Evidence |
|---|---|---|---|
| `withHostel(db, hostelId, fn)` in `src/db.ts` | Claude, at Nikhil's request | Done | One transaction marked with the hostel (`set_config('app.hostel_id', …, true)`, i.e. `SET LOCAL`); commits or rolls back; a connection whose rollback fails is discarded, not reused; a hostel id that is not a positive whole number is refused before connecting. 7 tests in `withHostel.test.ts` |
| Sign-in lookups, migration `014_auth_lookups.sql` | Claude | Done | `auth_user_by_id` (the session check, never the password hash) and `auth_user_by_email(hostel, email)` (sign-in in one hostel only), `SECURITY DEFINER` with a fixed `search_path`, callable by the app only. 12 tests in `authLookups.test.ts` |
| `requireAuth` | Claude | Done | Reads the user through `auth_user_by_id`; `req.user.hostelId` comes from the database, never the token; everyone of a suspended hostel is refused (401) |
| Login | Claude | Done | Reads the account through `auth_user_by_email`, in hostel #1 until each hostel has its own sign-in page (phase 3); a suspended hostel gets the same answer as a wrong password |

Checks: server 1119 tests (1098 before), typecheck clean. Two planted bugs were caught and
then removed: a hostel mark that outlived its transaction (`set_config(…, false)`), and
`requireAuth` ignoring a suspended hostel.

### Notes for later days

- 2b runs every route's queries inside `withHostel`. The 15 service functions that open
  their own transactions (`db.connect()` and `BEGIN`) will run inside the request's
  transaction instead.
- 2d must keep the nightly backup working: it dumps as `hostel_app`, and `pg_dump` refuses
  tables whose rows row-level security would hide. The backup needs its own role that may
  read every row, or a policy exemption.

## Multi-tenant SaaS, phase 2b-1: every request in its hostel's transaction (2026-11-07)

2b is split in two. 2b-1 (this part) runs everything that touches a hostel's data inside
`withHostel`; 2b-2 adds `hostel_id = current_hostel_id()` to every service query and names
the hostel on every insert. What the app does still does not change: every account is in
hostel #1.

| Part | Who | Status | Evidence |
|---|---|---|---|
| `current_hostel_id()`, migration `015_current_hostel.sql` | Claude, at Nikhil's request | Done | The hostel the transaction is marked with; fails (instead of returning NULL) outside `withHostel`; `STABLE`; callable by the app only. 4 tests in `currentHostel.test.ts` |
| Services' own transactions as savepoints | Claude | Done | `src/lib/savepoints.ts`, shared by `withHostel` and the tests' `rollbackDb`: a service's `BEGIN`/`COMMIT`/`ROLLBACK` becomes a savepoint inside the request's transaction, so its rollback undoes only its part. 1 new test in `withHostel.test.ts` |
| Routes | Claude | Done | `hostelWork(db)` next to `requireAuth` gives each router `inHostel(req, tx => …)`, with the hostel from the signed-in user. All 12 routers with sessions use it, `/me` and change-password included (bcrypt runs between two short transactions, never inside one). Calls that ran side by side (`Promise.all`) now run one after the other, as they share one connection. Route tests with mocked services check the service got a transaction, not the pool (`hostelTx` in `tests/helpers/db.ts`) |
| Public "Request access" form | Claude | Done | Runs in hostel #1 until each hostel has its own pages (phase 3), like password sign-in |
| Scheduled jobs (`run-jobs`) | Claude | Done | Run for every hostel in turn, each in its own transactions; counts are added up. A hostel whose jobs fail is logged and skipped, the others still run, and the call answers 500 at the end. `FEES_START_DATE` is hostel #1's only until phase 5 reads `hostels.fees_start_date`. `expirePhotos` takes the hostel and handles only its photos (1 new test) |
| Import and seed scripts | Claude | Done | `markHostel(c, 1)` right after their own `BEGIN` |

Checks: server 1125 tests (1119 before), typecheck clean. Two planted bugs were caught and
then removed: `expirePhotos` without its hostel filter, and a route calling a service with
the bare pool.

### Notes for later days

- The untracked local demo seed (`scripts/demoSeed.ts`) calls services directly. It passes
  today, but fails from 2b-2 on, when the services read `current_hostel_id()`: it needs to
  run inside `withHostel(db, 1, …)`.
- A failing hostel inside `run-jobs` has no test of its own yet; 2c's two-hostel tests
  should add one.
- Inside a test's rollback transaction, `withHostel` becomes a savepoint, and its hostel
  mark lasts until the test's transaction ends. Tests that run more than one hostel in one
  transaction (2c) must name the hostel again afterwards, or use separate transactions.

## Multi-tenant SaaS, phase 2b-2: every query scoped to its hostel (2026-11-07)

Every service and job query now filters on `hostel_id = current_hostel_id()`, and every
new row takes the transaction's hostel. What the app does still does not change: every
account is in hostel #1.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Reads, updates and deletes | Claude, at Nikhil's request | Done | The table each query starts from carries `hostel_id = current_hostel_id()` (services, jobs, `/me` and change-password). Rows reached through a join follow it: the composite foreign keys of migration 013 keep a child in its parent's hostel. Two joins that had no such key now say so: the poll counts join students of the poll's hostel, and a student's last stay is looked up in their own hostel |
| New rows, migration `016_hostel_id_default.sql` | Claude | Done | `hostel_id` defaults to `current_hostel_id()` on all 15 tables, instead of 1: an insert names the transaction's hostel without the code saying so, and an insert outside `withHostel` fails |
| `seed-owner` script | Claude | Done | Creates hostel #1's owner inside `withHostel(db, 1, …)` |
| Tests | Claude | Done | `hostelIsolation.test.ts` (2 tests): with hostel #1 and a second hostel each holding one of everything, hostel #1's 13 lists, counts and totals read the same before and after the second hostel's rows exist, and 29 lookups or changes by id of the second hostel's rows answer 404 and change nothing of its. `testPool()` connections start in hostel #1 for the session, so the existing tests that call services straight on the pool keep working; `bareTestPool()` has no hostel, like the app's pool. 3 new tests in `currentHostel.test.ts` |

Checks: server 1129 tests (1125 before), typecheck clean, two full runs. Ten planted bugs
(a filter removed each time): eight caught. The two not caught are the beds lists of the
dashboard and of the structure page, where another hostel's beds would be dropped anyway
when matched to this hostel's rooms; their filters stay.

### Notes for later days

- **Deployment order matters.** The code from 2b-1 on calls `current_hostel_id()`
  (migration 015), and migration 016 makes inserts outside `withHostel` fail, which the
  code before 2b-1 does. So: back up, apply 013 to 015, deploy this code, then apply 016.
  Applying 016 while the old code still runs would refuse every insert until the deploy.
- Still global, to be changed before other hostels can sign up (phase 2d or 4): the
  unique indexes on users' email, buildings' name and the one open return poll (only the
  per-hostel ones should stay); `hostel_settings`, still one row overall (`id = 1`); photo
  storage and egress usage (`services/usage.ts`), deliberately counted for the whole
  platform, because the limits are those of the one shared bucket; and the owner password
  reset script, a tool of the platform's operator that finds an owner by email anywhere.
- The untracked local demo seed (`npm run seed:demo`) now fails on its first insert: it
  needs to run inside `withHostel(db, 1, …)`. Its test still passes, because test pool
  connections start in hostel #1.

## Multi-tenant SaaS, phase 2c: two hostels through the routes (2026-11-07)

2c tests isolation the way a signed-in user meets it: through the routes, with the hostel
taken from the account. It found one real cross-hostel bug, fixed here.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Route-level two-hostel tests | Claude, at Nikhil's request | Done | `hostelIsolationRoutes.test.ts` (3 tests): two new hostels with one of everything; the app's hostel mark is cleared before every request, so a route without `withHostel` fails. Each owner's and student's 14 lists and counts show exactly their own rows; 28 routes given the other hostel's ids answer 404 in both directions and change nothing; each hostel's payment details stay its own |
| Payment details, one row per hostel (migration `017_per_hostel_uniques.sql`) | Claude | Done, bug fixed | `hostel_settings.id` was always 1, so a second hostel saving its UPI details would have overwritten the first hostel's row. The id now comes from a sequence and saving upserts on `hostel_id` |
| Per-hostel rules only (migration 017) | Claude | Done | Dropped the global unique indexes on email, building name and the one open poll; the per-hostel ones from migration 013 stay. Google accounts stay unique across hostels. Code that recognises a taken email knows both index names, for the deploy window |
| Owner password reset script | Claude | Done | Limited to hostel #1, the only hostel with password owners, now that an email may exist in two hostels |
| `run-jobs` with a failing hostel | Claude | Done | `jobsPerHostel.test.ts`: the failing hostel's work is rolled back, the hostel after it still runs, the failure is logged with the hostel's id, and the call answers 500 |
| Shared two-hostel fixtures | Claude | Done | `tests/helpers/hostels.ts`, used by the service-level and route-level tests |

Checks: server 1133 tests (1129 before), typecheck clean. Eight planted bugs: seven
caught. The one not caught is the status change's UPDATE without its hostel filter,
which the scoped lookup before it already stops with a 404.

### Notes for later days

- Deployment order, extended: back up, apply 013 to 015, deploy the code, then apply 016
  and 017.
- On this Windows machine the full run sometimes loses a test file to a worker crash
  (exit code 0xC0000409, in a different file each time); the files pass alone, and the full
  run passes with `npx vitest run --maxWorkers=4`. CI runs on Linux.
- 2d (row-level security) remains: policies on all 15 tables reading
  `current_hostel_id()`, a way for the nightly backup to read every row, and one owner per
  hostel.

## Multi-tenant SaaS, phase 2d: row-level security (2026-11-07)

2d makes the database itself keep each hostel's rows to that hostel. A query that forgets
its hostel filter, or a bug that passes another hostel's id, now finds nothing and can
write nothing outside the hostel `withHostel` marked the transaction with.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Policies on the 15 per-hostel tables (migration `018_row_level_security.sql`) | Claude, at Nikhil's request | Done | `hostel_app` reads, changes and deletes only rows where `hostel_id = current_hostel_id()`, and may write only such rows. Outside `withHostel` every query on these tables fails ("No hostel is set"). Not forced: the tables' owner (migrations, restores, the sign-in lookups of migration 014) is not limited. `rowSecurity.test.ts` (8 tests) sends SQL with no hostel filter and checks it sees, changes and deletes none of another hostel's rows |
| The nightly backup's own role, `hostel_backup` | Claude; the password is Nikhil's step | Done in code | Reads every row of every hostel and writes nothing; created without a login. `scripts/backup-role.ts` gives it the password from `BACKUP_DATABASE_URL` (6 tests in `backupRole.test.ts`). `backup.yml` dumps with `--enable-row-security`. Checked locally: `pg_dump` as `hostel_backup` succeeds with the flag and fails without it. The migration refuses an existing `hostel_backup` with more rights than a backup needs |
| Photo storage for the whole platform | Claude | Done | The storage limit is the one shared bucket's, so `photo_storage_bytes()` (owner's rights, one number) counts every hostel's photos; failing deletions stay each hostel's own. New test in `usage.test.ts` |
| Owner password reset script | Claude | Done | Runs inside hostel #1 (`withHostel`), since the table is no longer readable outside a hostel |
| Tests that build two hostels | Claude | Done | Rows of another hostel are now written and read from inside that hostel (`asHostel`), so the foreign keys, not row-level security, are what the cross-hostel tests see refusing; `rowsOfHostel` reads under the hostel's own mark and restores the previous one |
| Deploy and recovery docs | Claude | Done | `docs/deploy.md`: the `hostel_backup` URL, the one-time script, and the order for moving an existing deployment; `docs/RECOVERY.md`: the backup password as its own secret, and how to rotate it |

Checks: server 1148 tests (1133 before), typecheck clean. Eleven planted bugs: nine caught.
Not caught:
- the failing-deletions count without its hostel filter: row-level security still limits
  it to the hostel, which is what 2d is for;
- `hostel_backup` created with BYPASSRLS: roles belong to the whole server, so the role
  from an earlier run was reused and the planted CREATE never ran. The migration's guard
  against such a role was checked by hand instead: with BYPASSRLS given to the local role,
  the migration stopped with its message.

### Notes for later days

- Deployment order, complete: back up; apply 013 to 015; deploy the code; apply 016 to
  018; then at once give `hostel_backup` its login (`scripts/backup-role.ts`) and set the
  GitHub secret `BACKUP_DATABASE_URL` to its URL, and run the backup by hand. Until then
  the nightly backup fails, since `hostel_app` now sees one hostel at most.
  (`docs/deploy.md`, "Moving an existing deployment to hostels".)
- Nikhil's step: a third password for `hostel_backup`, and the secret above.
- The local demo seed (`scripts/demoSeed.ts`, Nikhil's uncommitted work) must run inside
  `withHostel(db, 1, …)`, like `seed-owner.ts`, or row-level security refuses its queries.
- One owner per hostel moves to phase 4 (sign-up), where each new hostel gets its owner;
  the tests still create many owners in hostel #1.
- `hostels` and `usage_counters` have no policies: they belong to no hostel.

## Multi-tenant SaaS, phase 3a: each hostel's own address (2026-11-07)

Phase 3 is in two parts: 3a gives every hostel its own sign-in and request-access pages,
3b lets owners sign in with Google. In 3a the hostel comes from the page's address,
`/h/<slug>/`, never from anything else in the request.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Hostel #1's address, `sns-hostel` (migration `019_hostel_one_slug.sql`) | Nikhil chose it; Claude | Done | Set only if still unset |
| `GET /api/hostels/:slug` | Claude, at Nikhil's request | Done | Public: the hostel's name and address only; an unknown, malformed or suspended address answers 404 `hostel_not_found` |
| Sign-in and the request form name their hostel | Claude | Done | `POST /api/auth/login` and `POST /api/rejoin-requests` take `hostel` (the slug). The same email may belong to accounts in two hostels; each address signs in only its own. An unknown or suspended hostel gets the wrong-password answer at sign-in. Without `hostel`, both still mean hostel #1, for the old pages, until phase 6 |
| `/me` names the hostel | Claude | Done | `{ user, hostel: { name, slug } }` |
| Client pages `/h/<slug>/login` and `/h/<slug>/request-access` | Claude | Done | Show the hostel's name; an unknown address says "No hostel here"; `/h/<slug>` leads to the sign-in page; signing out leads to the user's own hostel's sign-in page; the temporary-password card tells the owner the address their students sign in at |
| Tests | Claude | Done | `hostelSignIn.test.ts` (11 tests), `HostelAddress.test.tsx` (7 tests). `tests/helpers/rollbackDb.ts` now puts the test's hostel mark back when one of the app's transactions ends, as a real transaction's mark ends with it: run-jobs, which visits every hostel, had left the last one's mark behind |

Checks: server 1159 tests (1148 before), client 388 (381 before), both typechecks clean.
Twelve planted bugs, all caught after one new test: at first, an unknown address that
fell back to hostel #1 was missed, so a test now checks that a hostel #1 account cannot
sign in through an unknown or suspended address. Checked in the browser (built client
against the test database): `/h/sns-hostel` leads to the sign-in page, an unknown address
says so, the request page names the hostel, and signing out lands on the user's hostel's
page.

### Notes for later days

- Deployment: 019 goes with 016 to 018, after the code. Until the new client is live,
  students keep using the old address, which still means hostel #1.
- Hostel #1 is still named "HostelConnect", the placeholder from migration 013, so its
  page says "Sign in to HostelConnect" until the owner renames it (phase 4).
- 3b: Google sign-in for owners (server-side code flow with PKCE, keyed on Google's
  `sub`), linking Google to Nikhil's existing owner account, then dropping its password.
  Needs Nikhil's Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
- Phase 6 removes the requests that name no hostel, and the old `/login` and
  `/request-access` pages.

## Multi-tenant SaaS, phase 3b: owners sign in with Google (2026-11-09)

Owners can sign in with their Google account, link one to an existing owner account, and
then drop the password. Google sign-in stays off until its three settings are in Render
(`docs/deploy.md`, step 5a), so nothing changes in production before then.

| Part | Who | Status | Evidence |
|---|---|---|---|
| The flow, `src/lib/google.ts` | Claude, at Nikhil's request | Done | OpenID Connect's authorization code flow on the server, with PKCE (S256), state and nonce. The ID token is checked here against Google's published keys (RS256 only), issuer, audience, expiry, nonce and a Google-verified email; keys are cached as long as Google allows and fetched again for a new key. No new dependency. 15 tests in `google.test.ts` with a locally made key pair |
| Routes, `src/routes/google.ts` | Claude | Done | `GET /api/auth/options`, `/api/auth/google/start`, `/link` (signed-in owners) and `/callback`. What a sign-in must remember travels in a 10-minute signed httpOnly cookie on `/api/auth/google` only, cleared by the callback. The account is found by Google's `sub`, never the email. 15 tests in `googleSignIn.test.ts` with a fake Google that checks the PKCE verifier and nonce |
| Owner lookup by Google account (migration `020_google_sign_in.sql`) | Claude | Done | `auth_owner_by_google_sub`, like the lookups of migration 014: owners only, any hostel, callable by the app only |
| Linking and removing the password | Claude | Done | Linking only for the owner who started it and is still signed in; never replaces a linked account; a Google account another account uses is refused. `POST /api/auth/remove-password` needs Google linked and the current password; change-password then answers `no_password`. `/me` says `account: { googleLinked, hasPassword }`, never the Google id |
| Settings `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL` | Claude | Done | All three or none, checked at startup without printing values; 4 tests in `config.test.ts` |
| Client | Claude | Done | "Sign in with Google" on the sign-in pages when the server has it; the outcome of a Google sign-in explained there; Settings → Sign-in links Google and removes the password. 13 tests in `GoogleSignIn.test.tsx` |
| Docs | Claude | Done | `docs/deploy.md` step 5a (creating the OAuth client, Render settings, linking the existing owner), `docs/RECOVERY.md` (the new secret and rotating it), `.env.example` |

Checks: server 1193 tests (1159 before), client 401 (388 before), both typechecks clean.
Twenty-one planted bugs: eighteen caught at first. The replay test did not yet replay the
same callback, so a callback that left its cookie behind went unnoticed; it now does, and
catches it. Not caught, because another check already stops them: an explicit RS256 check
removed (`jwt.verify` still allows only RS256), and linking without the owner check (only
an owner can start linking, and the database refuses a Google id for a student). Checked
in the browser with dummy settings: the button and the no-account message show, `/start`
sends the browser to Google with PKCE, state, nonce and the flow cookie, and a stray
callback lands on `/login?google=failed`.

### Notes for later days

- Nikhil's steps: create the OAuth client and add the three settings to Render
  (`docs/deploy.md`, step 5a); then link Google to the owner account, check Google sign-in,
  and remove the password.
- Deployment: 020 goes with 016 to 019, after the code.
- Phase 4 (sign-up) starts from `?google=no-account`: an unknown Google account will be
  offered to create an owner account and a hostel instead.

## Multi-tenant SaaS, phase 4a: sign-up and the hostel's profile (2026-11-09)

A new owner signs up with Google, names the hostel, chooses its address and accepts the
terms, and is signed in to an empty hostel of their own. The owner can later rename the
hostel or move its address. Sign-up stays off until `SIGNUPS_OPEN=true` is in Render
(`docs/deploy.md`, step 5b), which waits for the reviewed Terms and Privacy Policy.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Accepted terms, migration `021_signup.sql` | Claude, at Nikhil's request | Done | `users.terms_version` and `terms_accepted_at`: both or neither, owners only, the version trimmed and 1 to 40 characters. `TERMS_VERSION` in `src/lib/legal.ts` |
| Making a hostel, `src/services/hostels.ts` | Claude | Done | `createHostelWithOwner`: the hostel and its one owner in one transaction (Google only, no password). It is the only way an owner is made, and it always makes a new hostel, so every hostel has one owner and a Google account owns one hostel at most (`users_google_sub_key`). `checkSlug` adds reserved addresses (`admin`, `api`, `signup`, …) |
| Sign-up routes, `src/routes/signup.ts` | Claude | Done | The Google callback gives an unknown account a 30-minute signed ticket (httpOnly cookie on `/api/signup` only, its own audience, so a session token is no ticket) and sends it to `/signup`. `GET /api/signup`, `GET /api/signup/slug`, `POST /api/signup` (terms accepted, the shown version or 409 `terms_changed`; five hostels an hour per IP, refused forms not counted). 15 tests in `signup.test.ts`, including that sign-up never adds an owner to an existing hostel |
| The hostel's profile, `PATCH /api/hostel` | Claude | Done | Owners only, their own hostel only (`withHostel`); a moved address frees the old one. 6 tests in `hostelProfile.test.ts` |
| Setting `SIGNUPS_OPEN` | Claude | Done | Off by default; the server will not start with it on and Google sign-in off; `/api/auth/options` says `signupsOpen`. 2 tests in `config.test.ts` |
| Client | Claude | Done | `/signup` (the address follows the hostel's name until edited, checked live; the terms checkbox also confirms guardians' consent for students under 18), placeholder `/terms` and `/privacy` (phase 4b), Settings → Hostel (rename, move the address with a warning that students' link changes), and "Set up your hostel with Google" on the main sign-in page while sign-up is open. 24 tests in `SignupPage.test.tsx` and `HostelProfile.test.tsx` |
| Docs | Claude | Done | `docs/deploy.md` step 5b, `.env.example` |

Checks: server 1216 tests (1193 before), client 425 (401 before), both typechecks clean.
Eighteen planted bugs: sixteen caught at first. The two misses now have tests: a token
signed with the server's secret and shaped like a ticket but without the sign-up audience
(a session token was already refused, as it has no email), and the sign-up page showing
what the server said about the previous address for a new one. Checked in the browser
against the test database, with a locally made ticket in place of Google: the main sign-in
page offers sign-up, `/signup` without a ticket sends you to Google, `/terms` shows the
placeholder; with the ticket the address follows the hostel's name and shows as free,
"Create my hostel" signs the owner in, and Settings → Hostel moved the address (the old one
then answers 404).

### Notes for later days

- Phase 4b: the plain-language Terms of Service and Privacy Policy on `/terms` and
  `/privacy`, marked as under legal review. Then a lawyer's review, then `SIGNUPS_OPEN`.
- Deployment: 021 goes with 016 to 020, after the code. With `SIGNUPS_OPEN` unset nothing
  changes for users, apart from Settings → Hostel.
- A new hostel starts empty: the owner sets up its buildings before admitting students.
  Its limits (300 students, 20 buildings) are enforced in phase 5.

## Multi-tenant SaaS, phase 4b: draft Terms of Service and Privacy Policy (2026-11-09)

Plain-language drafts on `/terms` and `/privacy`, written to match what the app does,
marked as under legal review. Sign-up stays closed until a lawyer has reviewed them.

| Part | Who | Status | Evidence |
|---|---|---|---|
| The text, `client/src/legal/documents.ts` | Claude, at Nikhil's request (phase 0) | Draft | Terms: the free beta and 30 days' notice before it stops or costs money, one hostel per Google account, the beta limits, the owner as Data Fiduciary and HostelConnect as Data Processor (DPDP Act 2023), guardians' consent for students under 18, no sensitive ID numbers in free text, fees paid outside the app, deletion on request within 30 days, no guarantee, changes re-accepted. Privacy Policy: what is recorded about owners and students, why, who sees it, the services used (Render, Supabase in Singapore; Google; GitHub backups, encrypted), how long it is kept, cookies, security, children, rights and grievances |
| The pages, `LegalPage.tsx` | Claude | Done | A readable page for each, its version, the under-review note, a link to the other; works on a phone and in both themes. 4 tests in `LegalPage.test.tsx` |
| Keeping the text true | Claude | Done | `server/tests/legalVersion.test.ts`: the documents' version is the one sign-up asks owners to accept, and the photo (48 hours), notification (60 days) and sign-in (7 days) periods are the server's. Changing any of the three on the server fails it (checked) |

Checks: server 1218 tests (1216 before), client 429 (425 before), both typechecks clean.
Checked in the browser: both pages, at phone width (no sideways scrolling) and in light
and dark.

### Notes for later days

- Still to fill in, in square brackets: the operator's legal name and address, the
  contact email, the grievance officer, the city for jurisdiction, and the liability
  limit. Then the lawyer's review; remove `UNDER_REVIEW` and set a final version (both
  `LEGAL_VERSION` and `TERMS_VERSION`) once it is approved.
- Promises the drafts make that rely on someone doing them by hand for now: deleting a
  hostel within 30 days of a request (with a copy if asked), answering rights requests
  within 30 days, and notice in the app before changes or stopping. A deletion script
  and a way to export a hostel's data would make them easier to keep.
- Phase 5 (guardian consent recorded per student under 18) makes the minors' promise
  checkable in the app.

## Multi-tenant SaaS, phase 5a: each hostel's limits and fees start date (2026-11-09)

Each hostel now keeps to its limits (300 current students, 20 buildings in the beta), and
starts tracking fees from its own date, which its owner sets in Settings. No migration:
the columns came with migration 013.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Limits, `src/services/hostels.ts` | Claude, at Nikhil's request (phase 0) | Done | `requireStudentPlace` before a student becomes current (admission and the import script through `insertStudentWithStay`, reactivation and approved rejoin requests through `reactivateInTransaction`); `requireBuildingPlace` before a building is added. Both lock the hostel's row first, so two admissions at once cannot both take the last place. Former students do not count. 409 `student_limit_reached` / `building_limit_reached`, telling the owner what to do. Tests in `hostelLimits.test.ts` |
| Each hostel's fees start date | Claude | Done | The hourly job creates fee rows for each hostel from `hostels.fees_start_date`; a hostel without one gets none. The owner sets or changes it with `PATCH /api/hostel` (2020-01-01 to a year ahead; it cannot be removed). `FEES_START_DATE` is written to hostel #1 at startup if hostel #1 has no date yet, then never again (`adoptFeesStartDate`). Tests in `jobsRoutes.test.ts`, `adoptFeesStartDate.test.ts`, `hostelLimits.test.ts` |
| `GET /api/hostel` | Claude | Done | The owner's own hostel: name, address, fees start date, limits and how much of them is used |
| Client | Claude | Done | Settings → Fees and limits: the start date (with what changing it does) and "102 of 300" for students and buildings, marked when full. 6 tests in `HostelFeesAndLimits.test.tsx`. Refusals at the limit show where they happen (checked in the browser on the Structure page) |
| Tests' hostel #1 | Claude | Done | `tests/globalSetup.ts` lifts hostel #1's limits in the test database, where every test file puts its rows (a full run leaves about 360 students and 90 buildings there) |
| Docs | Claude | Done | `docs/deploy.md` (raising a hostel's limits), `.env.example` (`FEES_START_DATE` is hostel #1's starting value only) |

Checks: server 1232 tests (1218 before), client 435 (429 before), both typechecks clean.
Fourteen planted bugs: eleven caught at first. Two now have tests: the limit check without
the hostel's lock (a deterministic test holds one admission open and checks the second
waits, then is refused), and Settings sending the old date instead of a changed one. Not
caught, because row-level security already stops it: usage counted over every hostel.
Checked in the browser against the test database with a hostel limited to one student and
one building: Settings showed "0 of 1" and "1 of 1 (full)", saved a start date, and the
Structure page showed the building-limit message.

### Notes for later days

- Deployment: no migration. Before it, decide hostel #1's limits (`docs/deploy.md`); if
  `FEES_START_DATE` is ever set in Render, the first start after this deploy copies it to
  hostel #1, and from then on the owner's Settings decide.
- Phase 5b: the CSV import per hostel (through the same limit), guardians' consent for
  students under 18, and photo storage per hostel.

## Multi-tenant SaaS, phase 5b: the import per hostel, guardians' consent, storage shares (2026-11-09)

The CSV import now goes into one chosen hostel within its limits; an owner confirms a
parent's or guardian's consent before adding a student under 18, and the app records who
and when; and each hostel's photos count against its own share of storage.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Migration 022 | Claude, at Nikhil's request (phase 0) | Done | `users.under_18`, `guardian_consent_at`, `guardian_consent_by` (an account of the same hostel). Checks: only students may be under 18, a student under 18 has a consent, and the time and the owner come together. Tests in `guardianConsent.test.ts` |
| Consent at admission and editing | Claude | Done | The route refuses `under18` without `guardianConsent` (400 naming `guardianConsent`); the service records the owner and the time the first time a student is marked, keeps them when another owner saves again, and keeps them after the student is unmarked (they turned 18). `GET /api/students/:id` shows `under18` and `guardianConsent: {on, by}` |
| The import, `scripts/importStudents.ts` | Claude | Done | `--hostel <address>` names the hostel; its one owner imports. The owner must belong to it. The whole file is checked against the hostel's limits first (students, and the new buildings it names) with the hostel's row locked. Optional columns `under_18` and `guardian_consent` (yes/no, empty for no). Tests in `importIntoHostel.test.ts` |
| Storage shares, `src/services/usage.ts` | Claude | Done | `hostelStorage`: this hostel's photos against the storage limit divided by the number of active hostels. Uploads switch off at 85% of the share or of the whole limit. Tests in `usage.test.ts` (a new hostel's share; one hostel's full share does not stop another's uploads) |
| Client | Claude | Done | "Under 18" on the admit and edit forms, with the consent checkbox when there is no consent yet; the profile shows "Guardian's consent confirmed by X on date"; the dashboard shows this hostel's photos against its share, and every hostel's photos once those pass 70% |
| Docs | Claude | Done | `docs/deploy.md` (storage shares, importing a register with `--hostel`, students under 18 and migration 022), `docs/import-template.csv` (the two optional columns) |

Checks: server 1255 tests (1232 before), client 443 (435 before), both typechecks clean.
Fifteen planted bugs: fourteen caught at first. The one missed (the edit form not carrying
a recorded consent, which would have stopped every save of a student under 18 without
saying why) now has a test. Checked in the browser against the test database: the admit
form asked for the consent, the profile named who confirmed it, saving again did not ask
twice, and the dashboard showed a 64.3 MB share.

### Notes for later days

- Deployment: apply migration 022 with **Migrate production database** before deploying
  this code. The import command now needs `--hostel sns-hostel` for hostel #1.
- Phase 6: remove the hostel #1 fallbacks, rehearse on a restored production backup.

## Multi-tenant SaaS, phase 6: no more hostel #1 fallbacks, and the rehearsal (2026-11-09)

Every password sign-in and every request to come back now names its hostel; the plain
`/login` and `/request-access` ask for the hostel's address first (Nikhil chose this over
a temporary redirect to SNS). The database side of "contract" was already done (global
uniques dropped in 017, `DEFAULT 1` replaced in 016). A script rehearses the whole move
on a restored production backup.

| Part | Who | Status | Evidence |
|---|---|---|---|
| Sign-in and the request form | Claude, at Nikhil's request | Done | `hostel` is required in `POST /api/auth/login` and `POST /api/rejoin-requests`; without it, 400 "hostel: open your hostel's own sign-in page, /h/<address>/login" (no account looked up, nothing filed). Tests in `authRoutes.test.ts`, `hostelSignIn.test.ts`; every other sign-in in the tests names `sns-hostel` |
| `/login` and `/request-access` | Claude | Done | `FindHostel`: the hostel's address (or a pasted sign-in link), looked up, then on to `/h/<address>/login` or `/request-access`; "No hostel has this address" otherwise. Owners still sign in with Google on `/login`, and new owners set up a hostel there. 9 tests in `FindHostel.test.tsx` |
| Owner password reset script | Claude | Done | `--hostel <address>` required; refuses an unknown hostel. Tried by hand: without `--hostel` it stops before connecting |
| Rehearsal, `ops/rehearse-saas.sh` + `server/scripts/rehearse-saas.ts` | Claude | Done, not yet run on a production backup | Restores the backup into the local `restore_drill`, runs 013 to 022, checks rows per table unchanged, one hostel (#1 at `sns-hostel`), every row in hostel #1, one owner, every password account found by sign-in, the app sees everything inside hostel #1 and is refused outside, nobody under 18. Prints counts only. Refuses any database but a local copy. Tried on a copy of the local demo database (at 012, 104 accounts): all migrations applied in 0.2 s, every check passed; with a planted change, the check failed and the script exited 1 |
| Docs | Claude | Done | `docs/deploy.md` (the move from 012 to 022 as one short break, with the new sign-in address for students first; first sign-in at `/h/sns-hostel/login`), `docs/RECOVERY.md` (the rehearsal; the reset script's `--hostel`) |

Checks: server 1257 tests (1255 before), client 452 (443 before), both typechecks clean.
Fourteen planted bugs, all caught. Checked in the browser against the test database:
`/login` asked for the address, refused an unknown one, and went on to
`/h/sns-hostel/login` for "SNS-Hostel"; `/request-access` asked first; sign-in and the
request without a hostel answered 400.

### Notes for later days

- Before deploying: run the rehearsal on the newest production backup (Nikhil, with the
  backup key) and record its output here; give the students `/h/sns-hostel/login`.
- `FEES_START_DATE` and `adoptFeesStartDate` stay for now (production has none set, so
  they do nothing there); they can go in a later clean-up.

### Rehearsal on the production backup (2026-11-09)

`ops/rehearse-saas.sh` on `hostelconnect-2026-11-09T0109Z.dump.age` (production at
012): migrations 013 to 022 applied in 0.2 s, and every check passed. Rows per table
unchanged (3 users, 2 buildings, 2 floors, 2 rooms, 6 beds, 3 stays, 2 announcements, 1
notification, 1 return poll, the rest empty); one hostel, #1, active, at `sns-hostel`; every
row in hostel #1; one owner; every account with a password found by sign-in; the app sees
all 3 accounts inside hostel #1 and is refused outside any hostel. Hostel #1 has no fees
start date yet (the owner sets it in Settings after the move). The local copy was dropped
afterwards.
