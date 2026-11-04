-- Day 5: rejoin requests from former students, and in-app notifications (design doc,
-- sections 3, 5 and 9). Both tables in one migration, so production needs one run.

-- ---- Rejoin requests ----

-- A former student asks to come back from the login page; the owner approves (which
-- reactivates the account) or rejects. Rows are the history of every request.
CREATE TABLE rejoin_requests (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id  bigint NOT NULL REFERENCES users (id),
  -- Optional; the form trims it and sends NULL for an empty message.
  message     text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 500),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  bigint REFERENCES users (id),

  -- A pending request has no decision yet; a decided one says when and by whom.
  CONSTRAINT rejoin_requests_decision CHECK (
    (status = 'pending') = (decided_at IS NULL AND decided_by IS NULL)
    AND (decided_at IS NULL) = (decided_by IS NULL)
  )
);

-- One open request per student, even if two arrive at once; the service turns the
-- refusal into the same answer as every other request.
CREATE UNIQUE INDEX rejoin_requests_one_pending ON rejoin_requests (student_id)
  WHERE status = 'pending';
-- The owner's list: pending (or decided) requests, oldest first.
CREATE INDEX rejoin_requests_status_created ON rejoin_requests (status, created_at);

-- Requests are history: the app may only record a decision on one, never delete it or
-- change who asked or what they wrote.
REVOKE DELETE ON rejoin_requests FROM hostel_app;
REVOKE UPDATE ON rejoin_requests FROM hostel_app;
GRANT UPDATE (status, decided_at, decided_by) ON rejoin_requests TO hostel_app;

-- ---- Notifications ----

-- One row per person per event, shown by the bell, which the app polls about once a
-- minute. The type list is section 3's; widening it is a one-line CHECK change.
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users (id),
  type        text NOT NULL CHECK (type IN (
                'announcement', 'return_poll', 'complaint_update',
                'fee_reminder', 'payment_update', 'daily_digest')),
  title       text NOT NULL CHECK (btrim(title) <> '' AND char_length(title) <= 120),
  body        text CHECK (body IS NULL OR char_length(body) <= 500),
  -- A path inside the app, such as /complaints/42; never a link to another site.
  -- Browsers read "//host" and "/\host" as another site too, so the character after
  -- the first slash may be neither a slash nor a backslash.
  link        text CHECK (link IS NULL OR link ~ '^/([^/\\]|$)'),
  -- Set for events that must reach a person only once, such as a fee reminder or the
  -- daily digest.
  dedup_key   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);

-- The bell: a person's notifications, newest first.
CREATE INDEX notifications_user_created ON notifications (user_id, created_at DESC);
-- The same reminder or digest is never created twice for one person, even if the job
-- runs twice.
CREATE UNIQUE INDEX notifications_user_dedup_key ON notifications (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- The app may mark a notification read and may delete notifications (deleting an
-- announcement removes its notifications; the job prunes rows older than 60 days), but
-- may not rewrite one.
REVOKE UPDATE ON notifications FROM hostel_app;
GRANT UPDATE (read_at) ON notifications TO hostel_app;
