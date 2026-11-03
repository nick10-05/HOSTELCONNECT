-- Owner and students share one table (design doc, section 3).
CREATE TABLE users (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role                 text NOT NULL CHECK (role IN ('student', 'owner')),
  name                 text NOT NULL CHECK (btrim(name) <> ''),
  email                text NOT NULL CHECK (btrim(email) <> ''),
  phone                text,
  parent_phone         text,
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  category             text CHECK (category IN ('college', 'working', 'other')),
  college_name         text,
  branch               text,
  academic_year        smallint,
  company              text,
  designation          text,
  joining_date         date,
  food_preference      text CHECK (food_preference IN ('veg', 'non_veg')),
  monthly_fee          integer CHECK (monthly_fee IS NULL OR monthly_fee >= 0),
  is_active            boolean NOT NULL DEFAULT true,
  deactivated_at       timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- The owner needs only the basics. A student needs the full profile, and the
  -- category decides which extra columns are required.
  CONSTRAINT users_student_fields CHECK (
    role = 'owner'
    OR (
      phone IS NOT NULL
      AND parent_phone IS NOT NULL
      AND category IS NOT NULL
      AND joining_date IS NOT NULL
      AND food_preference IS NOT NULL
      AND (category <> 'college'
           OR (college_name IS NOT NULL AND branch IS NOT NULL AND academic_year IS NOT NULL))
      AND (category <> 'working' OR company IS NOT NULL)
    )
  )
);

-- Login is case-insensitive: Asha@x.com and asha@x.com are the same person.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- People are deactivated, never deleted (design doc, section 8). Enforce that in
-- the database too, so even a bug in the app cannot erase a student.
REVOKE DELETE ON users FROM hostel_app;
