-- Multi-tenant phase 3b: owners sign in with Google. Google tells the app which Google
-- account signed in (its `sub`), not which hostel, so the owner is found before any hostel
-- is known: through this function, which runs as the tables' owner, like the lookups of
-- migration 014 (row-level security, migration 018, shows hostel_app no row outside a
-- hostel). Owners only: a student never signs in with Google (users_google_owners_only).
-- google_sub is unique across all hostels (users_google_sub_key), so one row at most.
CREATE FUNCTION auth_owner_by_google_sub(p_sub text)
  RETURNS TABLE (
    id                   bigint,
    hostel_id            bigint,
    role                 text,
    is_active            boolean,
    hostel_active        boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.hostel_id, u.role, u.is_active, h.status = 'active'
  FROM users u
  JOIN hostels h ON h.id = u.hostel_id
  WHERE u.google_sub = p_sub AND u.role = 'owner'
$$;

REVOKE EXECUTE ON FUNCTION auth_owner_by_google_sub(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_owner_by_google_sub(text) TO hostel_app;
