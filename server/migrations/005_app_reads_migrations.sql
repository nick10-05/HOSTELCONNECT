-- The nightly backup logs in as hostel_app and dumps every table in public, including
-- schema_migrations, so a restored copy knows which migrations it already has.
-- The runner creates that table before migration 001 sets the default rights, so
-- hostel_app never got to read it. Reading is all it needs.
GRANT SELECT ON schema_migrations TO hostel_app;
