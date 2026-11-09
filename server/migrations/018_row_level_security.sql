-- Multi-tenant phase 2d: the database itself keeps each hostel's rows to that hostel.
--
-- Phase 2b scoped every query in the code (hostel_id = current_hostel_id()). Row-level
-- security now does the same in the database, for every query hostel_app runs, so a
-- query that forgets its filter, or a bug that passes another hostel's id, still finds
-- only the rows of the hostel withHostel marked the transaction with:
--   - SELECT, UPDATE and DELETE see only that hostel's rows;
--   - INSERT and UPDATE may write only rows of that hostel (WITH CHECK);
--   - outside withHostel there is no hostel, and current_hostel_id() fails the query.
-- Not FORCE: the tables' owner (the migration role) still sees every row, so migrations
-- and restores (ops/restore-data.sh) work as before, and so do the sign-in lookups of
-- migration 014, which run as the owner (SECURITY DEFINER). Foreign key checks are not
-- affected by row-level security.
--
-- hostels, usage_counters and schema_migrations belong to no hostel and keep no policy.

-- ---- The nightly backup's role ----
-- pg_dump logged in as hostel_app until now; with these policies it would see one hostel
-- at most. hostel_backup may read every row of every table and write nothing. It is
-- created without a login, so this file holds no password: scripts/backup-role.ts gives
-- it one, run once by the operator with the migration credential (docs/deploy.md).
-- Roles belong to the whole server, so one may already exist: it is used only if it has
-- no right beyond logging in (the migration role cannot take such rights away on
-- Supabase, where only a superuser may change them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostel_backup') THEN
    CREATE ROLE hostel_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostel_backup'
                AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'The role hostel_backup already exists with more rights than a backup needs; remove them first';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hostel_backup', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO hostel_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hostel_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO hostel_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hostel_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO hostel_backup;

-- ---- The policies ----
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'buildings', 'floors', 'rooms', 'beds', 'stays', 'rejoin_requests',
    'notifications', 'complaints', 'complaint_events', 'announcements', 'return_polls',
    'return_poll_responses', 'fees', 'hostel_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY hostel_isolation ON %I TO hostel_app
         USING (hostel_id = current_hostel_id())
         WITH CHECK (hostel_id = current_hostel_id())', t);
    EXECUTE format('CREATE POLICY backup_reads_all ON %I FOR SELECT TO hostel_backup USING (true)', t);
  END LOOP;
END
$$;

-- ---- Photo storage for the whole platform ----
-- The photo storage limit is the one shared bucket's (services/usage.ts), so the bytes
-- stored are counted over every hostel's photos, which hostel_app can no longer see.
-- Runs as the owner; returns one number and nothing about any hostel.
CREATE FUNCTION photo_storage_bytes() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(sum(photo_size_bytes), 0)::bigint
  FROM complaints
  WHERE photo_path IS NOT NULL AND photo_deleted_at IS NULL
$$;
REVOKE EXECUTE ON FUNCTION photo_storage_bytes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_storage_bytes() TO hostel_app;
