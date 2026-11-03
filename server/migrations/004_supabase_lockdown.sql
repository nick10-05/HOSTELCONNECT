-- Supabase only. Every Supabase project has the roles "anon" and "authenticated" for
-- its built-in Data API, and by default they get full rights on new tables in the
-- public schema. Anyone holding the project's "anon key" (which Supabase treats as
-- public) could then read and change our tables through that API.
-- HostelConnect never uses that API: the server connects directly as hostel_app.
-- So both roles lose every right here, now and for tables created later.
-- Locally and in CI these roles do not exist, and this migration does nothing.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
      -- Default privileges belong to the role that creates the tables: the migration
      -- role running this file, which also runs every later migration.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
