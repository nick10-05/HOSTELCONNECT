-- Day 9: return polls, fee rows and the owner's payment details (design doc, sections 3,
-- 5 and 9). All three in one migration, so production needs one run.

-- ---- Return polls ----

-- An occasional poll after a holiday: "who is back?". It covers every active student at
-- the time it is read: "no response" is an active student with no row in
-- return_poll_responses, so there is no recipient table (section 3).
CREATE TABLE return_polls (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Trimmed (spaces, tabs and line breaks), 1 to 120 characters (section 3).
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by  bigint NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,

  CONSTRAINT return_polls_title_check CHECK (
    title = btrim(title, E' \t\n\r') AND char_length(title) BETWEEN 1 AND 120),
  -- An open poll has no closing time; a closed one says when.
  CONSTRAINT return_polls_closed CHECK ((status = 'open') = (closed_at IS NULL))
);

-- At most one open poll (decided on day 9): the dashboard card and the student's tile
-- show "the" open poll. Two owners' clicks at once cannot open two; the service turns
-- the refusal into a 409. Every open row has the same key, so a second one collides.
CREATE UNIQUE INDEX return_polls_one_open ON return_polls ((true)) WHERE status = 'open';
-- The owner's list, newest first.
CREATE INDEX return_polls_created ON return_polls (created_at DESC);

-- Polls are history: the app may change only a poll's status and closing time, never its
-- title, author or creation time, and may not delete it. The grant alone would still let
-- a closed poll be set open again; the service refuses that (closing is final), and the
-- one-open index above holds either way.
REVOKE DELETE ON return_polls FROM hostel_app;
REVOKE UPDATE ON return_polls FROM hostel_app;
GRANT UPDATE (status, closed_at) ON return_polls TO hostel_app;

-- A student's answer; changeable while the poll is open (the service checks that the
-- poll is open, under a lock on the poll row).
CREATE TABLE return_poll_responses (
  poll_id       bigint NOT NULL REFERENCES return_polls (id),
  student_id    bigint NOT NULL REFERENCES users (id),
  response      text NOT NULL CHECK (response IN ('returned', 'not_yet')),
  responded_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (poll_id, student_id)
);

-- The app may change an answer, never move it to another poll or person, or delete it.
REVOKE DELETE ON return_poll_responses FROM hostel_app;
REVOKE UPDATE ON return_poll_responses FROM hostel_app;
GRANT UPDATE (response, responded_at) ON return_poll_responses TO hostel_app;

-- ---- Fees ----

-- One row per student per due date (section 3). The nth due date is the joining date plus
-- n months, clamped to the month's end (services/fees.ts, nthDueDate). The job creates a
-- row once its due date is within 7 days, and none for due dates before FEES_START_DATE.
-- The rows are the payment history; "overdue" is not stored.
CREATE TABLE fees (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id   bigint NOT NULL REFERENCES users (id),
  due_date     date NOT NULL,
  -- Rupees, copied from users.monthly_fee when the row is created; NULL when no fee was
  -- set (decided on day 9: shown as "amount not set", adds nothing to a total).
  amount       integer CHECK (amount IS NULL OR amount >= 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  -- The owner's payment date (India's today by default; never after today, checked by
  -- the service) and who marked it.
  paid_on      date,
  recorded_by  bigint REFERENCES users (id),
  -- Optional, for example "paid by UPI"; trimmed, at most 200 characters.
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- The job can never create a second row for the same due date, even if it runs twice.
  CONSTRAINT fees_student_due_date UNIQUE (student_id, due_date),
  -- Paid means a date and who recorded it; marking it pending again clears all three.
  CONSTRAINT fees_paid CHECK (
    (status = 'paid') = (paid_on IS NOT NULL)
    AND (paid_on IS NULL) = (recorded_by IS NULL)
    AND (status = 'paid' OR note IS NULL)
  ),
  CONSTRAINT fees_note_check CHECK (
    note IS NULL OR (note = btrim(note, E' \t\n\r') AND char_length(note) BETWEEN 1 AND 200))
);

-- The owner's list by month and status. A student's own history uses the unique index
-- above (student_id first).
CREATE INDEX fees_due_date_status ON fees (due_date, status);

-- Fee rows are never deleted (section 8), and their student, due date and amount never
-- change: the app may only mark a row paid or pending again.
REVOKE DELETE ON fees FROM hostel_app;
REVOKE UPDATE ON fees FROM hostel_app;
GRANT UPDATE (status, paid_on, recorded_by, note) ON fees TO hostel_app;

-- ---- The owner's payment details ----

-- One row at most (id is always 1). It is created the first time the owner saves his
-- details, so "not set yet" is simply no row. Students see the UPI ID, the payee name and
-- the QR: his uploaded image, or one the browser draws from the UPI ID.
CREATE TABLE hostel_settings (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- A UPI ID, such as name@bank or 9876543210@ybl: 3 to 255 characters, exactly one '@'
  -- with something on each side, and no whitespace anywhere. Deliberately loose (decided
  -- on day 9): providers' handles vary and change, so no provider list is checked.
  upi_id          text CHECK (upi_id IS NULL OR (
                    char_length(upi_id) BETWEEN 3 AND 255
                    AND upi_id ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  -- Trimmed, 1 to 100 characters.
  upi_payee_name  text CHECK (upi_payee_name IS NULL OR (
                    upi_payee_name = btrim(upi_payee_name, E' \t\n\r')
                    AND char_length(upi_payee_name) BETWEEN 1 AND 100)),
  -- At most 200 KB (section 3); type checked by content in the server, as for photos.
  qr_image        bytea CHECK (qr_image IS NULL OR octet_length(qr_image) BETWEEN 1 AND 204800),
  qr_mime         text CHECK (qr_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- An image always has its type.
  CONSTRAINT hostel_settings_qr_mime CHECK ((qr_image IS NULL) = (qr_mime IS NULL)),
  -- At least one of the UPI ID or the QR image (section 3).
  CONSTRAINT hostel_settings_something_set CHECK (upi_id IS NOT NULL OR qr_image IS NOT NULL)
);

-- The app may create the row and change its details, never delete it (default grants
-- give INSERT). The id column is fixed.
REVOKE DELETE ON hostel_settings FROM hostel_app;
REVOKE UPDATE ON hostel_settings FROM hostel_app;
GRANT UPDATE (upi_id, upi_payee_name, qr_image, qr_mime, updated_at) ON hostel_settings TO hostel_app;
