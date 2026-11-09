-- Multi-tenant phase 2a: the two lookups that come before a request knows its hostel.
--
-- From phase 2d, row-level security hides every row of users unless the request has named
-- its hostel (withHostel in src/db.ts). Two steps cannot name it yet:
--   - checking a session (requireAuth): the cookie names a user, not a hostel;
--   - signing in: the student's page names the hostel (phase 3), but the account still has
--     to be found by email before anything else is known.
-- These functions see past the hostel boundary for exactly those two questions and return
-- only what each needs. Everything else in the app goes through withHostel.
--
-- SECURITY DEFINER: they run with the rights of their owner (the migration credential),
-- not the caller's, and that owner is exempt from row-level security (phase 2d). The fixed
-- search_path keeps anyone from putting a table of their own in front of ours.
-- Tests: tests/authLookups.test.ts.

-- The session check: who this is, which hostel, and whether they may still get in
-- (an active account in an active hostel). Never the password hash or contact details.
CREATE FUNCTION auth_user_by_id(p_user_id bigint)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    role                 text,
    must_change_password boolean,
    is_active            boolean,
    hostel_active        boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.role, u.must_change_password, u.is_active, h.status = 'active'
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.id = p_user_id
$$;

-- Sign-in: the account for this email in this hostel, with the password hash to compare
-- and the name shown after signing in. Case-insensitive, as login has always been; the
-- per-hostel index on (hostel_id, lower(email)) makes it one row at most.
CREATE FUNCTION auth_user_by_email(p_hostel_id bigint, p_email text)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    name                 text,
    role                 text,
    must_change_password boolean,
    is_active            boolean,
    hostel_active        boolean,
    password_hash        text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.name, u.role, u.must_change_password, u.is_active,
         h.status = 'active', u.password_hash
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.hostel_id = p_hostel_id AND lower(u.email) = lower(p_email)
$$;

-- Functions are callable by everyone unless told otherwise. Only the app may call these.
REVOKE EXECUTE ON FUNCTION auth_user_by_id(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_user_by_email(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_id(bigint) TO hostel_app;
GRANT EXECUTE ON FUNCTION auth_user_by_email(bigint, text) TO hostel_app;
