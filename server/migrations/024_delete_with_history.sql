-- Deleting buildings and rooms that students have lived in, with an email code.
--
-- Until now a building or room that any stay ever referred to could never be deleted:
-- the stays' foreign keys refused, so the history would stay complete. From here on the
-- owner may delete it, and the history still stays readable:
--   1. every stay keeps a copy of its place's names (building, floor, room, bed), filled
--      in by the database itself;
--   2. deleting a building, room or bed only empties the stay's id column that pointed at
--      it; the stay and its copied names stay;
--   3. a current or future stay never loses its place: the delete is refused instead
--      (the service checks first; the checks below are the backstop);
--   4. each deletion needs a 6-digit code sent to the owner's email (deletion_codes) and
--      is written to a log that the app can only add to (structure_deletions).
-- Deploy: this file first (today's code keeps working with it), then the new code.

-- ---- 1. Copied names on every stay ----

ALTER TABLE stays
  ADD COLUMN building_name text,
  ADD COLUMN floor_number  smallint,
  ADD COLUMN room_number   text,
  ADD COLUMN bed_number    text;

-- Existing stays. Runs as the tables' owner, so it sees every hostel's rows. Only these
-- four columns change, so no other trigger fires.
UPDATE stays s
SET building_name = (SELECT b.name FROM buildings b WHERE b.id = s.building_id),
    room_number   = (SELECT r.room_number FROM rooms r WHERE r.id = s.room_id),
    floor_number  = (SELECT f.number FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = s.room_id),
    bed_number    = (SELECT bd.bed_number FROM beds bd WHERE bd.id = s.bed_id);

ALTER TABLE stays ALTER COLUMN building_name SET NOT NULL;

-- Fills the copies whenever a stay is written or moved. A place column that is emptied
-- because its building, room or bed was just deleted keeps its copied name: that is the
-- history. An empty room or bed for any other reason (a future stay moved to "no room")
-- clears the copy, so the copy always describes the place the stay has.
-- Runs as the tables' owner (SECURITY DEFINER), so it finds the place whatever the
-- hostel: a stay pointing into another hostel is then refused by the composite foreign
-- keys, as before, rather than by a missing name. It reads three names and writes only
-- the stay being written.
--
-- Only a column that really changed is looked at, and a name is only overwritten when its
-- row is found: while a room is deleted, its beds go first, and clearing the stay's bed
-- must not re-read the room (already gone) and blank the room's copy.
CREATE FUNCTION stays_copy_place_names() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  found_name text;
  found_floor smallint;
BEGIN
  IF NEW.building_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.building_id IS DISTINCT FROM OLD.building_id) THEN
    SELECT name INTO found_name FROM buildings WHERE id = NEW.building_id;
    IF FOUND THEN NEW.building_name := found_name; END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    IF NEW.room_id IS NOT NULL THEN
      SELECT r.room_number, f.number INTO found_name, found_floor
      FROM rooms r LEFT JOIN floors f ON f.id = r.floor_id
      WHERE r.id = NEW.room_id;
      IF FOUND THEN
        NEW.room_number := found_name;
        NEW.floor_number := found_floor;
      END IF;
    ELSIF TG_OP = 'INSERT' OR EXISTS (SELECT 1 FROM rooms WHERE id = OLD.room_id) THEN
      NEW.room_number := NULL;
      NEW.floor_number := NULL;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.bed_id IS DISTINCT FROM OLD.bed_id THEN
    IF NEW.bed_id IS NOT NULL THEN
      SELECT bed_number INTO found_name FROM beds WHERE id = NEW.bed_id;
      IF FOUND THEN NEW.bed_number := found_name; END IF;
    ELSIF TG_OP = 'INSERT' OR EXISTS (SELECT 1 FROM beds WHERE id = OLD.bed_id) THEN
      NEW.bed_number := NULL;
    END IF;
  END IF;

  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION stays_copy_place_names() FROM PUBLIC;

CREATE TRIGGER stays_copy_place_names
  BEFORE INSERT OR UPDATE OF building_id, room_id, bed_id ON stays
  FOR EACH ROW EXECUTE FUNCTION stays_copy_place_names();

-- The app may not write the copies itself (an insert's are overwritten by the trigger).
-- Its UPDATE rights on stays stay as they were: ended_on, building_id, room_id, bed_id.

-- ---- 2. Deleting a place empties only its own column ----

-- The building may now be missing (deleted); its name is always kept.
ALTER TABLE stays ALTER COLUMN building_id DROP NOT NULL;

-- Each key clears only its own column (PostgreSQL 15+), never hostel_id or a neighbour.
-- The composite keys still tie a room to the stay's building and a bed to its room; the
-- single-column room and bed keys make sure the id is cleared whichever key Postgres
-- handles first (a composite key with one column already empty no longer matches).
ALTER TABLE stays
  DROP CONSTRAINT stays_building_id_fkey,
  DROP CONSTRAINT stays_hostel_building_fkey,
  DROP CONSTRAINT stays_room_id_building_id_fkey,
  DROP CONSTRAINT stays_bed_id_room_id_fkey;

ALTER TABLE stays
  ADD CONSTRAINT stays_building_id_fkey FOREIGN KEY (building_id)
    REFERENCES buildings (id) ON DELETE SET NULL (building_id),
  ADD CONSTRAINT stays_hostel_building_fkey FOREIGN KEY (hostel_id, building_id)
    REFERENCES buildings (hostel_id, id) ON DELETE SET NULL (building_id),
  ADD CONSTRAINT stays_room_id_building_id_fkey FOREIGN KEY (room_id, building_id)
    REFERENCES rooms (id, building_id) ON DELETE SET NULL (room_id),
  ADD CONSTRAINT stays_room_id_fkey FOREIGN KEY (room_id)
    REFERENCES rooms (id) ON DELETE SET NULL (room_id),
  ADD CONSTRAINT stays_bed_id_room_id_fkey FOREIGN KEY (bed_id, room_id)
    REFERENCES beds (id, room_id) ON DELETE SET NULL (bed_id),
  ADD CONSTRAINT stays_bed_id_fkey FOREIGN KEY (bed_id)
    REFERENCES beds (id) ON DELETE SET NULL (bed_id);

-- A bed needs a room, except on a past stay: while a deleted room's beds go with it, the
-- stay's room id may be cleared a moment before its bed id.
ALTER TABLE stays
  DROP CONSTRAINT stays_bed_needs_room,
  ADD CONSTRAINT stays_bed_needs_room CHECK (bed_id IS NULL OR room_id IS NOT NULL OR ended_on IS NOT NULL);

-- ---- 3. A current or future stay keeps its place ----

-- Ended stays may lose their ids; a stay with no end may not. A room or bed it never had
-- (copy empty) is fine.
ALTER TABLE stays
  ADD CONSTRAINT stays_current_keeps_place CHECK (
    ended_on IS NOT NULL
    OR (building_id IS NOT NULL
        AND (room_id IS NOT NULL OR room_number IS NULL)
        AND (bed_id IS NOT NULL OR bed_number IS NULL))
  );

-- Migration 007 fixed a started stay's place. Emptying a column because its building,
-- room or bed no longer exists is the one change now allowed on any stay (the deletion's
-- foreign keys do exactly that). The app cannot empty one itself: the place still exists.
CREATE OR REPLACE FUNCTION stays_place_fixed_once_started() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.building_id IS NOT DISTINCT FROM OLD.building_id
      OR (NEW.building_id IS NULL AND NOT EXISTS (SELECT 1 FROM buildings WHERE id = OLD.building_id)))
     AND (NEW.room_id IS NOT DISTINCT FROM OLD.room_id
      OR (NEW.room_id IS NULL AND NOT EXISTS (SELECT 1 FROM rooms WHERE id = OLD.room_id)))
     AND (NEW.bed_id IS NOT DISTINCT FROM OLD.bed_id
      OR (NEW.bed_id IS NULL AND NOT EXISTS (SELECT 1 FROM beds WHERE id = OLD.bed_id))) THEN
    RETURN NEW;
  END IF;
  IF OLD.ended_on IS NOT NULL
     OR OLD.started_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'A stay that has started or ended cannot be moved; transfer instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stays_place_fixed_once_started';
  END IF;
  RETURN NEW;
END
$$;

-- ---- 4. Email codes and the deletions log ----

-- One row per code sent. The code itself is never stored: code_hash is an HMAC-SHA256 of
-- the row id and the code, keyed with a secret only the server knows
-- (services/structureDeletion.ts). A code works once, for 5 minutes, for 5 tries, for
-- the one building or room it was sent for, and only while it is the owner's newest.
CREATE TABLE deletion_codes (
  id             uuid PRIMARY KEY,
  hostel_id      bigint NOT NULL DEFAULT current_hostel_id() REFERENCES hostels (id),
  owner_id       bigint NOT NULL,
  target_kind    text NOT NULL CHECK (target_kind IN ('building', 'room')),
  target_id      bigint NOT NULL,
  target_name    text NOT NULL CHECK (btrim(target_name) <> ''),
  code_hash      bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  attempts       smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at    timestamptz,
  superseded_at  timestamptz,
  send_failed_at timestamptz,
  CONSTRAINT deletion_codes_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CONSTRAINT deletion_codes_hostel_owner_fkey FOREIGN KEY (hostel_id, owner_id) REFERENCES users (hostel_id, id)
);
CREATE INDEX deletion_codes_owner_created ON deletion_codes (owner_id, created_at DESC);
CREATE INDEX deletion_codes_hostel_created ON deletion_codes (hostel_id, created_at);

-- The app writes a code once, then only counts tries and marks it used, replaced or not
-- sent. DELETE stays for the nightly clean-up (jobs/pruneNotifications.ts).
REVOKE UPDATE ON deletion_codes FROM hostel_app;
GRANT UPDATE (attempts, consumed_at, superseded_at, send_failed_at) ON deletion_codes TO hostel_app;

-- Tries only go up, and used / replaced / not-sent, once set, never change: a used code
-- cannot be made usable again, even by a bug.
CREATE FUNCTION deletion_codes_one_way() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.attempts < OLD.attempts
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.send_failed_at IS NOT NULL AND NEW.send_failed_at IS DISTINCT FROM OLD.send_failed_at) THEN
    RAISE EXCEPTION 'A deletion code only moves forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deletion_codes_one_way';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION deletion_codes_one_way() FROM PUBLIC;
CREATE TRIGGER deletion_codes_one_way BEFORE UPDATE ON deletion_codes
  FOR EACH ROW EXECUTE FUNCTION deletion_codes_one_way();

-- One row per building or room deleted: what, who, when, how much went with it, and the
-- code that allowed it. The app may add rows and read them, never change or remove them.
-- code_id has no foreign key: old codes are cleaned up, the log stays.
CREATE TABLE structure_deletions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hostel_id    bigint NOT NULL DEFAULT current_hostel_id() REFERENCES hostels (id),
  kind         text NOT NULL CHECK (kind IN ('building', 'room')),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  deleted_by   bigint NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  floors       integer NOT NULL CHECK (floors >= 0),
  rooms        integer NOT NULL CHECK (rooms >= 0),
  beds         integer NOT NULL CHECK (beds >= 0),
  past_stays   integer NOT NULL CHECK (past_stays >= 0),
  code_id      uuid NOT NULL,
  verified_at  timestamptz NOT NULL,
  CONSTRAINT structure_deletions_hostel_deleted_by_fkey FOREIGN KEY (hostel_id, deleted_by) REFERENCES users (hostel_id, id)
);
REVOKE UPDATE, DELETE ON structure_deletions FROM hostel_app;

-- The same rules as every other hostel table (migrations 013 and 018).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deletion_codes', 'structure_deletions'] LOOP
    EXECUTE format(
      'CREATE TRIGGER hostel_id_fixed BEFORE UPDATE OF hostel_id ON %I FOR EACH ROW '
      'WHEN (OLD.hostel_id IS DISTINCT FROM NEW.hostel_id) EXECUTE FUNCTION hostel_id_fixed()',
      t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY hostel_isolation ON %I TO hostel_app
         USING (hostel_id = current_hostel_id())
         WITH CHECK (hostel_id = current_hostel_id())', t);
    EXECUTE format('CREATE POLICY backup_reads_all ON %I FOR SELECT TO hostel_backup USING (true)', t);
  END LOOP;
END
$$;
