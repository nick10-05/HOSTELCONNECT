-- Multi-tenant phase 2b: the hostel the current transaction works in.
--
-- withHostel (src/db.ts) marks each request's transaction with its hostel
-- (app.hostel_id, SET LOCAL). Every query about a hostel's data filters on this function
-- (hostel_id = current_hostel_id()) and every insert names it, so the hostel comes from
-- one place only and no service passes it around by hand. Row-level security (phase 2d)
-- reads the same mark.
--
-- Outside withHostel there is no mark, and the function fails instead of returning NULL:
-- a forgotten withHostel then breaks loudly in tests rather than quietly matching no
-- hostel (or, once a filter is missing, every hostel). Tests: tests/currentHostel.test.ts.
--
-- STABLE: the answer does not change within a statement, so Postgres calls it once per
-- statement and can still use indexes on hostel_id.
CREATE FUNCTION current_hostel_id() RETURNS bigint
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog
AS $$
DECLARE
  mark text := current_setting('app.hostel_id', true);
BEGIN
  IF mark IS NULL OR mark = '' THEN
    RAISE EXCEPTION 'No hostel is set for this transaction'
      USING HINT = 'Run the query inside withHostel (src/db.ts).';
  END IF;
  RETURN mark::bigint;
END
$$;

REVOKE EXECUTE ON FUNCTION current_hostel_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_hostel_id() TO hostel_app;
