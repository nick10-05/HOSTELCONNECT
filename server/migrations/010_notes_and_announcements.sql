-- Day 7: the owner's notes on complaints, and announcements (design doc, sections 3, 4,
-- 5 and 9).

-- ---- The owner's notes ----

-- A note (on its own, or with a status change) is at most 500 characters (decided on
-- day 7) and stored trimmed, as the services store it. char_length counts characters, so
-- an emoji is one. The trimmed characters are spaces, tabs and line breaks, as for a
-- complaint's description in 009.
ALTER TABLE complaint_events
  ADD CONSTRAINT complaint_events_note_length
    CHECK (note IS NULL OR char_length(note) <= 500),
  ADD CONSTRAINT complaint_events_note_trimmed
    CHECK (note IS NULL OR note = btrim(note, E' \t\n\r')),
  -- Section 4: reopening needs a note, as rejecting does (009). The only reopen is
  -- resolved -> open (decided on day 7).
  ADD CONSTRAINT complaint_events_reopen_has_note
    CHECK (NOT (from_status = 'resolved' AND to_status = 'open') OR note IS NOT NULL);

-- ---- Announcements ----

-- The owner's notices to every student. Posting notifies every active student with
-- dedup_key 'announcement:<id>'; deleting an announcement deletes those notifications.
-- Notifications are matched by that key, not by a foreign key.
CREATE TABLE announcements (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id   bigint NOT NULL REFERENCES users (id),
  -- Both trimmed (spaces, tabs and line breaks) and not empty; at most 120 and 2000
  -- characters (section 3). The body is required (decided on day 7).
  title       text NOT NULL,
  body        text NOT NULL,
  is_urgent   boolean NOT NULL DEFAULT false,
  is_pinned   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT announcements_title_check CHECK (
    title = btrim(title, E' \t\n\r') AND char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT announcements_body_check CHECK (
    body = btrim(body, E' \t\n\r') AND char_length(body) BETWEEN 1 AND 2000)
);

-- The list: pinned first, then newest.
CREATE INDEX announcements_pinned_created ON announcements (is_pinned DESC, created_at DESC);

-- The app may edit, pin, mark urgent and delete (section 5), never change who wrote an
-- announcement or when.
REVOKE UPDATE ON announcements FROM hostel_app;
GRANT UPDATE (title, body, is_urgent, is_pinned, updated_at) ON announcements TO hostel_app;
