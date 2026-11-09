-- Multi-tenant phase 2b-2: every new row belongs to the hostel of the transaction that
-- inserts it.
--
-- Migration 013 gave hostel_id the default 1, so the code of the time kept working while
-- every row was hostel #1's. From here on the default is current_hostel_id() (migration
-- 015): an insert inside withHostel names that hostel without the code saying so, and an
-- insert outside withHostel fails ("No hostel is set for this transaction") instead of
-- quietly landing in hostel #1. The composite foreign keys (migration 013) still refuse a
-- row whose parent belongs to another hostel.
--
-- Existing rows do not change: a default only applies to new rows. A row inserted with an
-- explicit hostel_id (restores, tests) keeps the one it names.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'buildings', 'floors', 'rooms', 'beds', 'stays', 'rejoin_requests',
    'notifications', 'complaints', 'complaint_events', 'announcements', 'return_polls',
    'return_poll_responses', 'fees', 'hostel_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN hostel_id SET DEFAULT current_hostel_id()', t);
  END LOOP;
END
$$;
