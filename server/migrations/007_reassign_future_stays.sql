-- Reassigning a stay that has not started (decided on day 5): a student admitted with a
-- future joining date has a current stay that starts on that date. Until then the owner
-- may change its building, room or bed in place, with no history row, because the
-- student has not lived anywhere yet. Once a stay has started, its place is history and
-- a move is a transfer: end this stay, start a new one (migration 003).

-- 1. The app role may also change where a stay is. Who (student_id), when (started_on)
--    and by whom (created_by) still cannot change, and stays still cannot be deleted.
GRANT UPDATE (building_id, room_id, bed_id) ON stays TO hostel_app;

-- 2. ...but only on a current stay that starts after today, by India's date (the same
--    "today" as server/src/lib/dates.ts). The service checks this first and chooses
--    reassign or transfer; this trigger is the guard if code ever gets it wrong.
--    The named CONSTRAINT lets code recognise the refusal by err.constraint, like an index.
CREATE FUNCTION stays_place_fixed_once_started() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.ended_on IS NOT NULL
     OR OLD.started_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'A stay that has started or ended cannot be moved; transfer instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stays_place_fixed_once_started';
  END IF;
  RETURN NEW;
END
$$;

-- Only the trigger calls it. A trigger runs its function without checking EXECUTE,
-- so nobody needs that right.
REVOKE EXECUTE ON FUNCTION stays_place_fixed_once_started() FROM PUBLIC;

-- Fires only when the place really changes, so ending a stay (SET ended_on) never
-- reaches it.
CREATE TRIGGER stays_place_fixed_once_started
  BEFORE UPDATE OF building_id, room_id, bed_id ON stays
  FOR EACH ROW
  WHEN ((OLD.building_id, OLD.room_id, OLD.bed_id)
        IS DISTINCT FROM (NEW.building_id, NEW.room_id, NEW.bed_id))
  EXECUTE FUNCTION stays_place_fixed_once_started();
