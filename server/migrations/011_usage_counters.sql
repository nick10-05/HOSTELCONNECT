-- Day 8: the usage guard's bandwidth estimate (design doc, sections 3 and 10).

-- One row per counter and month, for example 'egress:2026-11': the bytes of photos the
-- app has issued signed links for this month. Every issued link adds the photo's size, so
-- the value only ever grows; a new month simply starts a new row. Storage in use is not a
-- counter: it is the sum of photo_size_bytes over photos not yet deleted.
CREATE TABLE usage_counters (
  -- A name and a month in India's calendar, 'name:YYYY-MM'.
  key         text PRIMARY KEY,
  value       bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usage_counters_key_format CHECK (key ~ '^[a-z_]+:[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT usage_counters_value_check CHECK (value >= 0)
);

-- The app adds to a counter (INSERT ... ON CONFLICT DO UPDATE) and reads it; it never
-- deletes one or renames its key, so a month's usage cannot be wiped by a bug.
REVOKE DELETE ON usage_counters FROM hostel_app;
REVOKE UPDATE ON usage_counters FROM hostel_app;
GRANT UPDATE (value, updated_at) ON usage_counters TO hostel_app;
