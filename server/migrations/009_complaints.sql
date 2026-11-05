-- Day 6: student complaints and their timeline (design doc, sections 3, 4 and 9).
-- Day 6 is text only; the photo columns are created now (decided on day 6) so that
-- photos on day 8 need no migration, but nothing writes them before then.

-- ---- Complaints ----

-- One row per complaint. Complaints are permanent: the app can change a complaint's
-- status and priority, never its author, category or text, and never delete it.
CREATE TABLE complaints (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id            bigint NOT NULL REFERENCES users (id),
  category              text NOT NULL CHECK (category IN (
                          'plumbing', 'electrical', 'cleanliness', 'internet',
                          'food', 'furniture', 'security', 'other')),
  -- 10 to 500 characters after trimming (decided on day 6). The service stores the
  -- trimmed text, so the stored value must already be trimmed and the length is
  -- checked on it. The trimmed characters are spaces, tabs and line breaks; anything
  -- JavaScript's trim() returns passes the first test.
  description           text NOT NULL CHECK (
                          description = btrim(description, E' \t\n\r')
                          AND char_length(description) BETWEEN 10 AND 500),
  -- Set by the owner only; students never see it.
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),

  -- Photo (day 8): a random object name in the private bucket, its size for the usage
  -- guard, and when it expires (created_at + 48 hours). photo_deleted_at is set only
  -- after storage confirms the deletion; the path stays, so the row still says a photo
  -- existed. The job counts failed deletions in photo_delete_attempts.
  photo_path            text CHECK (photo_path IS NULL OR btrim(photo_path) <> ''),
  photo_size_bytes      integer CHECK (photo_size_bytes IS NULL OR photo_size_bytes > 0),
  photo_expires_at      timestamptz,
  photo_deleted_at      timestamptz,
  photo_delete_attempts smallint NOT NULL DEFAULT 0 CHECK (photo_delete_attempts >= 0),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Set when the owner resolves; cleared if he reopens.
  resolved_at           timestamptz,

  CONSTRAINT complaints_resolved_at CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  -- A photo has a path, a size and an expiry time together; only an existing photo can
  -- be deleted.
  CONSTRAINT complaints_photo_fields CHECK (
    (photo_path IS NULL) = (photo_size_bytes IS NULL)
    AND (photo_path IS NULL) = (photo_expires_at IS NULL)
    AND (photo_deleted_at IS NULL OR photo_path IS NOT NULL)
  )
);

-- The one limit that lives in the database: a student has at most one active complaint
-- per category, even if two requests arrive at once. The other two limits (3 active,
-- 2 new per 24 hours) are service checks with configurable numbers. A resolved or
-- rejected complaint frees its category again.
CREATE UNIQUE INDEX complaints_one_active_per_category ON complaints (student_id, category)
  WHERE status IN ('open', 'in_progress');
-- A student's own list, newest first, and the 24-hour count.
CREATE INDEX complaints_student_created ON complaints (student_id, created_at DESC);
-- The owner's list: active first, high priority first, oldest first.
CREATE INDEX complaints_status_priority_created ON complaints (status, priority, created_at);
-- The day 8 job: photos that are due for deletion and not yet deleted.
CREATE INDEX complaints_photo_due ON complaints (photo_expires_at)
  WHERE photo_path IS NOT NULL AND photo_deleted_at IS NULL;

-- The app may change only the owner's fields (day 7) and the job's photo bookkeeping
-- (day 8).
REVOKE DELETE ON complaints FROM hostel_app;
REVOKE UPDATE ON complaints FROM hostel_app;
GRANT UPDATE (status, priority, updated_at, resolved_at, photo_deleted_at, photo_delete_attempts)
  ON complaints TO hostel_app;

-- ---- Complaint events (the timeline) ----

-- 'created' is written with the complaint; status changes and notes are the owner's
-- (day 7). Rows are history: the app can add them, never change or delete them.
CREATE TABLE complaint_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  complaint_id bigint NOT NULL REFERENCES complaints (id) ON DELETE CASCADE,
  actor_id     bigint NOT NULL REFERENCES users (id),
  kind         text NOT NULL CHECK (kind IN ('created', 'status_change', 'note')),
  note         text CHECK (note IS NULL OR btrim(note) <> ''),
  from_status  text CHECK (from_status IS NULL
                 OR from_status IN ('open', 'in_progress', 'resolved', 'rejected')),
  to_status    text CHECK (to_status IS NULL
                 OR to_status IN ('open', 'in_progress', 'resolved', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT complaint_events_status_change_has_to_status
    CHECK (kind <> 'status_change' OR to_status IS NOT NULL),
  CONSTRAINT complaint_events_note_has_note
    CHECK (kind <> 'note' OR note IS NOT NULL),
  -- Rejecting needs a note, such as "duplicate of #41".
  CONSTRAINT complaint_events_reject_has_note
    CHECK (to_status IS DISTINCT FROM 'rejected' OR note IS NOT NULL)
);

-- A complaint's timeline in order.
CREATE INDEX complaint_events_complaint_created ON complaint_events (complaint_id, created_at);

REVOKE DELETE ON complaint_events FROM hostel_app;
REVOKE UPDATE ON complaint_events FROM hostel_app;
