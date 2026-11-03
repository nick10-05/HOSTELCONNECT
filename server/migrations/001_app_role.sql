-- The app logs in as hostel_app, a limited role: it can read and write rows but
-- cannot create, alter, drop or truncate tables. Migrations run as the admin role.
-- The password is NOT in this file (the repo is public): the migration runner hands
-- it over for the duration of this transaction, taken from DATABASE_URL.

DO $$
DECLARE
  pw text := current_setting('hostelconnect.app_password');
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hostel_app') THEN
    EXECUTE format(
      'CREATE ROLE hostel_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', pw);
  ELSE
    EXECUTE format(
      'ALTER ROLE hostel_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', pw);
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hostel_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO hostel_app;

-- Every table the admin creates from now on is usable by the app, with no TRUNCATE
-- and no DDL. Individual migrations can narrow this further (see 002 for users).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hostel_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hostel_app;
