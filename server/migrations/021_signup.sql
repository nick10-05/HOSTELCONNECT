-- Multi-tenant phase 4a: owners sign up. Each owner who signs up accepts the Terms of
-- Service and the Privacy Policy; which version they accepted, and when, is kept with
-- their account (decided in phase 0), so a later version can ask again.
-- Both or neither: an account made before sign-up existed (hostel #1's owner, students)
-- has accepted nothing through the app.
ALTER TABLE users
  ADD COLUMN terms_version text CONSTRAINT users_terms_version_check CHECK (
    terms_version = btrim(terms_version) AND char_length(terms_version) BETWEEN 1 AND 40),
  ADD COLUMN terms_accepted_at timestamptz,
  ADD CONSTRAINT users_terms_both CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL)),
  ADD CONSTRAINT users_terms_owners_only CHECK (terms_version IS NULL OR role = 'owner');
