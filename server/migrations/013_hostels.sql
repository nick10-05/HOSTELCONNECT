-- Multi-tenant SaaS, phase 1: the "expand" step (decided on 2026-11-07, docs/decisions.md).
--
-- HostelConnect becomes a platform where any owner signs up and runs their own hostel.
-- Every row that belongs to a hostel now says which one (hostel_id). Today's single
-- hostel and all its data become hostel #1.
--
-- Nothing the current code does changes: every per-hostel table gets
-- hostel_id ... DEFAULT 1, so rows written without a hostel, as today's code writes them,
-- land in hostel #1. Only adding here: no row is moved, rewritten or deleted.
--
-- What the database guarantees from now on, whatever the code does:
-- - a row can never point into another hostel (composite foreign keys on hostel_id);
-- - a row never changes hostel (the hostel_id_fixed trigger);
-- - only the platform admin sets a hostel's status and limits.
--
-- Left for later phases: the per-hostel unique indexes below sit NEXT TO today's global
-- ones, which are dropped in phase 6 ("contract"), together with DEFAULT 1, once the code
-- always names the hostel. One owner per hostel and row-level security come in phase 2,
-- when the tests and the code know about hostels. Tests: tests/tenancyTables.test.ts.

-- ---- The hostels ----

CREATE TABLE hostels (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Trimmed (spaces, tabs and line breaks), 1 to 100 characters.
  name            text NOT NULL CHECK (
                    name = btrim(name, E' \t\n\r') AND char_length(name) BETWEEN 1 AND 100),
  -- The hostel's part of its students' address, /h/<slug>/login: 3 to 40 lowercase
  -- letters, digits and single hyphens, not starting or ending with a hyphen. NULL until
  -- chosen (hostel #1 chooses before phase 3).
  slug            text CHECK (
                    slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND position('--' IN slug) = 0),
  -- Suspended by the platform admin, for abuse or at the owner's request.
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- The free beta's limits (decided on 2026-11-07); the admin raises them per hostel.
  student_limit   integer NOT NULL DEFAULT 300 CHECK (student_limit > 0),
  building_limit  integer NOT NULL DEFAULT 20 CHECK (building_limit > 0),
  -- Each hostel's go-live date for fees, replacing the FEES_START_DATE setting in phase 5.
  fees_start_date date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Two hostels never share an address. Hostels without a slug yet do not clash (NULLs).
CREATE UNIQUE INDEX hostels_slug_key ON hostels (slug);

-- The owner creates their hostel at sign-up (name and slug) and may rename it, change the
-- slug and set the fee start. The status and limits are the platform admin's, through the
-- migration credential; a hostel is suspended, never deleted by the app.
REVOKE INSERT, UPDATE, DELETE ON hostels FROM hostel_app;
GRANT INSERT (name, slug) ON hostels TO hostel_app;
GRANT UPDATE (name, slug, fees_start_date) ON hostels TO hostel_app;

-- Hostel #1: today's hostel and every row already in the database. Renamed by its owner
-- once the hostel profile page exists (phase 4).
INSERT INTO hostels (name) VALUES ('HostelConnect');

-- DEFAULT 1 below depends on this, so refuse to go on if it ever came out differently.
DO $$
BEGIN
  IF (SELECT id FROM hostels WHERE name = 'HostelConnect') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'hostel #1 was not created with id 1';
  END IF;
END
$$;

-- ---- hostel_id on every per-hostel table ----

-- Adding a column with a constant default is instant in Postgres: existing rows are not
-- rewritten, they simply read 1.

-- People. The owner and the students of a hostel.
ALTER TABLE users
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1 CONSTRAINT users_hostel_id_fkey REFERENCES hostels (id),
  -- Target for the composite keys below: "user X of hostel H".
  ADD CONSTRAINT users_hostel_id_id_key UNIQUE (hostel_id, id);

ALTER TABLE buildings
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1 CONSTRAINT buildings_hostel_id_fkey REFERENCES hostels (id),
  ADD CONSTRAINT buildings_hostel_id_id_key UNIQUE (hostel_id, id);

-- Floors and rooms are in their building's hostel, and beds in their room's. ON DELETE
-- CASCADE as the existing keys, so deleting an unused building still takes its floors,
-- rooms and beds with it.
ALTER TABLE floors
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT floors_hostel_building_fkey FOREIGN KEY (hostel_id, building_id)
    REFERENCES buildings (hostel_id, id) ON DELETE CASCADE;

ALTER TABLE rooms
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT rooms_hostel_id_id_key UNIQUE (hostel_id, id),
  ADD CONSTRAINT rooms_hostel_building_fkey FOREIGN KEY (hostel_id, building_id)
    REFERENCES buildings (hostel_id, id) ON DELETE CASCADE;

ALTER TABLE beds
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT beds_hostel_room_fkey FOREIGN KEY (hostel_id, room_id)
    REFERENCES rooms (hostel_id, id) ON DELETE CASCADE;

-- A stay's student, building and author are all of its hostel. Its room and bed follow:
-- the existing keys already tie them to the stay's building.
ALTER TABLE stays
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT stays_hostel_student_fkey FOREIGN KEY (hostel_id, student_id) REFERENCES users (hostel_id, id),
  ADD CONSTRAINT stays_hostel_building_fkey FOREIGN KEY (hostel_id, building_id) REFERENCES buildings (hostel_id, id),
  ADD CONSTRAINT stays_hostel_created_by_fkey FOREIGN KEY (hostel_id, created_by) REFERENCES users (hostel_id, id);

-- A NULL decided_by (or recorded_by, below) skips its key, as a plain foreign key does.
ALTER TABLE rejoin_requests
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT rejoin_requests_hostel_student_fkey FOREIGN KEY (hostel_id, student_id) REFERENCES users (hostel_id, id),
  ADD CONSTRAINT rejoin_requests_hostel_decided_by_fkey FOREIGN KEY (hostel_id, decided_by) REFERENCES users (hostel_id, id);

ALTER TABLE notifications
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT notifications_hostel_user_fkey FOREIGN KEY (hostel_id, user_id) REFERENCES users (hostel_id, id);

ALTER TABLE complaints
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT complaints_hostel_id_id_key UNIQUE (hostel_id, id),
  ADD CONSTRAINT complaints_hostel_student_fkey FOREIGN KEY (hostel_id, student_id) REFERENCES users (hostel_id, id);

ALTER TABLE complaint_events
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT complaint_events_hostel_complaint_fkey FOREIGN KEY (hostel_id, complaint_id)
    REFERENCES complaints (hostel_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT complaint_events_hostel_actor_fkey FOREIGN KEY (hostel_id, actor_id) REFERENCES users (hostel_id, id);

ALTER TABLE announcements
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT announcements_hostel_author_fkey FOREIGN KEY (hostel_id, author_id) REFERENCES users (hostel_id, id);

ALTER TABLE return_polls
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT return_polls_hostel_id_id_key UNIQUE (hostel_id, id),
  ADD CONSTRAINT return_polls_hostel_created_by_fkey FOREIGN KEY (hostel_id, created_by) REFERENCES users (hostel_id, id);

ALTER TABLE return_poll_responses
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT return_poll_responses_hostel_poll_fkey FOREIGN KEY (hostel_id, poll_id) REFERENCES return_polls (hostel_id, id),
  ADD CONSTRAINT return_poll_responses_hostel_student_fkey FOREIGN KEY (hostel_id, student_id) REFERENCES users (hostel_id, id);

ALTER TABLE fees
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT fees_hostel_student_fkey FOREIGN KEY (hostel_id, student_id) REFERENCES users (hostel_id, id),
  ADD CONSTRAINT fees_hostel_recorded_by_fkey FOREIGN KEY (hostel_id, recorded_by) REFERENCES users (hostel_id, id);

-- Each hostel's payment details. Still one row overall (id = 1) until phase 2 moves the
-- key to hostel_id; this index already allows at most one row per hostel.
ALTER TABLE hostel_settings
  ADD COLUMN hostel_id bigint NOT NULL DEFAULT 1 CONSTRAINT hostel_settings_hostel_id_fkey REFERENCES hostels (id);
CREATE UNIQUE INDEX hostel_settings_hostel_key ON hostel_settings (hostel_id);

-- ---- A row never changes hostel ----

-- The column grants already keep the app from changing hostel_id on most tables, but
-- users, buildings, floors, rooms and beds give the app UPDATE on every column. One rule
-- for all, in the database: moving a row to another hostel is refused. Named like a
-- constraint, so code and tests recognise it by err.constraint.
CREATE FUNCTION hostel_id_fixed() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'A row never moves to another hostel'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'hostel_id_fixed';
END
$$;

-- Only the triggers call it, and a trigger needs no EXECUTE right.
REVOKE EXECUTE ON FUNCTION hostel_id_fixed() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'announcements', 'beds', 'buildings', 'complaint_events', 'complaints', 'fees', 'floors',
    'hostel_settings', 'notifications', 'rejoin_requests', 'return_poll_responses',
    'return_polls', 'rooms', 'stays', 'users'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER hostel_id_fixed BEFORE UPDATE OF hostel_id ON %I FOR EACH ROW '
      'WHEN (OLD.hostel_id IS DISTINCT FROM NEW.hostel_id) EXECUTE FUNCTION hostel_id_fixed()',
      t);
  END LOOP;
END
$$;

-- ---- Per-hostel rules, next to today's global ones ----

-- An email is one person within a hostel; the same person may live in two hostels over
-- the years. The global users_email_lower_key stays until phase 6.
CREATE UNIQUE INDEX users_hostel_email_lower_key ON users (hostel_id, lower(email));

-- Building names are unique within a hostel (global buildings_name_lower_key until phase 6).
CREATE UNIQUE INDEX buildings_hostel_name_lower_key ON buildings (hostel_id, lower(name));

-- One open return poll per hostel (global return_polls_one_open until phase 6).
CREATE UNIQUE INDEX return_polls_one_open_per_hostel ON return_polls (hostel_id) WHERE status = 'open';

-- ---- Owners sign in with Google ----

-- Google's account id (the ID token's "sub"): stable, unlike an email address, so the
-- owner's account is found by it. Owners only; students keep email and password.
ALTER TABLE users
  ADD COLUMN google_sub text CONSTRAINT users_google_sub_check CHECK (
    google_sub = btrim(google_sub) AND char_length(google_sub) BETWEEN 1 AND 255),
  ADD CONSTRAINT users_google_owners_only CHECK (google_sub IS NULL OR role = 'owner'),
  -- An owner who signs in with Google needs no password. Everyone else still has one.
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD CONSTRAINT users_can_sign_in CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);

-- One Google account is one owner.
CREATE UNIQUE INDEX users_google_sub_key ON users (google_sub);
