-- Multi-tenant phase 5b: students under 18. Before an owner adds a student under 18, they
-- confirm they have a parent's or guardian's consent (decided in phase 0); the app keeps
-- who confirmed it and when. The Terms and Privacy Policy (phase 4b) promise this.
--   under_18             marked by the owner at admission, in the import, or when editing
--   guardian_consent_*   who confirmed the consent (an owner of the same hostel) and when;
--                        kept when the student is later unmarked (they turned 18)
ALTER TABLE users
  ADD COLUMN under_18 boolean NOT NULL DEFAULT false,
  ADD COLUMN guardian_consent_at timestamptz,
  ADD COLUMN guardian_consent_by bigint,
  ADD CONSTRAINT users_guardian_consent_by_fkey
    FOREIGN KEY (hostel_id, guardian_consent_by) REFERENCES users (hostel_id, id),
  ADD CONSTRAINT users_under_18_students_only CHECK (NOT under_18 OR role = 'student'),
  ADD CONSTRAINT users_guardian_consent_both CHECK ((guardian_consent_at IS NULL) = (guardian_consent_by IS NULL)),
  ADD CONSTRAINT users_under_18_consent CHECK (NOT under_18 OR guardian_consent_at IS NOT NULL);
