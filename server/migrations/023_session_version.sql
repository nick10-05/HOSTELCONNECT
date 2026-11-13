-- Security audit, finding F1: a sign-in ends when its password changes.
--
-- A session is a signed cookie good for 7 days. Before this, nothing on the server could end
-- one early: a stolen session kept working after the student changed the password, or after
-- the owner reset it to shut the thief out.
--
-- session_version counts the account's password changes. Every session carries the number
-- it was signed with (src/lib/token.ts), and requireAuth refuses one whose number is no
-- longer the account's. The database raises it itself, whenever password_hash changes, so no
-- path that sets a password (change, reset, reactivation, removing it for Google) can forget
-- to, and the app can never set it back.
-- Tests: tests/sessionRevocation.test.ts.
ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 0;

CREATE FUNCTION users_session_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.session_version := OLD.session_version
    + CASE WHEN NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN 1 ELSE 0 END;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION users_session_version() FROM PUBLIC;

CREATE TRIGGER users_session_version
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_session_version();

-- The three sign-in lookups (migrations 014 and 020) also return the number, so a new
-- session is signed with it. Same bodies otherwise; a function's columns cannot change in
-- place, so each is made again, with its grants.
DROP FUNCTION auth_user_by_id(bigint);
CREATE FUNCTION auth_user_by_id(p_user_id bigint)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    role                 text,
    must_change_password boolean,
    is_active            boolean,
    hostel_active        boolean,
    session_version      integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.role, u.must_change_password, u.is_active, h.status = 'active',
         u.session_version
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.id = p_user_id
$$;

DROP FUNCTION auth_user_by_email(bigint, text);
CREATE FUNCTION auth_user_by_email(p_hostel_id bigint, p_email text)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    name                 text,
    role                 text,
    must_change_password boolean,
    is_active            boolean,
    hostel_active        boolean,
    password_hash        text,
    session_version      integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.name, u.role, u.must_change_password, u.is_active,
         h.status = 'active', u.password_hash, u.session_version
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.hostel_id = p_hostel_id AND lower(u.email) = lower(p_email)
$$;

DROP FUNCTION auth_owner_by_google_sub(text);
CREATE FUNCTION auth_owner_by_google_sub(p_sub text)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    role                 text,
    is_active            boolean,
    hostel_active        boolean,
    session_version      integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.role, u.is_active, h.status = 'active', u.session_version
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.google_sub = p_sub AND u.role = 'owner'
$$;

REVOKE EXECUTE ON FUNCTION auth_user_by_id(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_user_by_email(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_owner_by_google_sub(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_by_id(bigint) TO hostel_app;
GRANT EXECUTE ON FUNCTION auth_user_by_email(bigint, text) TO hostel_app;
GRANT EXECUTE ON FUNCTION auth_owner_by_google_sub(text) TO hostel_app;
