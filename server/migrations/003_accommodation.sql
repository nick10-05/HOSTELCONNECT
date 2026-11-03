-- Accommodation (design doc, section 3). Only the building is required; floors,
-- rooms and beds are optional levels the owner adds whenever he wants.

CREATE TABLE buildings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- "Building A" and "building a" are the same building.
CREATE UNIQUE INDEX buildings_name_lower_key ON buildings (lower(name));

-- Deleting a building also deletes its floors and rooms, but only while no stay
-- has ever referenced it: the foreign keys from stays refuse otherwise.
CREATE TABLE floors (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id bigint NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  number      smallint NOT NULL, -- 0 = ground floor
  UNIQUE (building_id, number),
  -- Target for the composite key on rooms below.
  UNIQUE (id, building_id)
);

CREATE TABLE rooms (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id bigint NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  floor_id    bigint, -- a room may sit straight under a building
  room_number text NOT NULL CHECK (btrim(room_number) <> ''),
  UNIQUE (building_id, room_number),
  UNIQUE (id, building_id),
  -- The floor must belong to the same building. The design left this to the service;
  -- a composite key makes it impossible to break. NULL floor_id skips the check.
  -- A floor that still has rooms cannot be deleted on its own.
  FOREIGN KEY (floor_id, building_id) REFERENCES floors (id, building_id)
);

CREATE TABLE beds (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id    bigint NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  bed_number text NOT NULL CHECK (btrim(bed_number) <> ''),
  is_active  boolean NOT NULL DEFAULT true, -- false = retired
  UNIQUE (room_id, bed_number),
  UNIQUE (id, room_id)
);

-- One row per period a student lives somewhere. A transfer ends the current stay and
-- starts a new one, so old rows are the history.
CREATE TABLE stays (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id  bigint NOT NULL REFERENCES users (id),
  building_id bigint NOT NULL REFERENCES buildings (id),
  room_id     bigint,
  bed_id      bigint,
  started_on  date NOT NULL,
  ended_on    date, -- NULL = current stay
  created_by  bigint NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT stays_bed_needs_room CHECK (bed_id IS NULL OR room_id IS NOT NULL),
  -- Equal dates allowed: a same-day transfer ends one stay and starts the next today.
  CONSTRAINT stays_dates_in_order CHECK (ended_on IS NULL OR ended_on >= started_on),
  -- The room must be in the stay's building and the bed in the stay's room.
  FOREIGN KEY (room_id, building_id) REFERENCES rooms (id, building_id),
  FOREIGN KEY (bed_id, room_id) REFERENCES beds (id, room_id)
);

-- Even if two requests race, the database refuses a second current stay for a
-- student or a second current student in a bed; the service turns that into a 409.
CREATE UNIQUE INDEX stays_one_current_per_student ON stays (student_id) WHERE ended_on IS NULL;
CREATE UNIQUE INDEX stays_one_current_per_bed ON stays (bed_id)
  WHERE ended_on IS NULL AND bed_id IS NOT NULL;
-- Stay history on the profile, and the lookups behind the delete checks.
CREATE INDEX stays_student_started ON stays (student_id, started_on DESC);
CREATE INDEX stays_building_current ON stays (building_id) WHERE ended_on IS NULL;
CREATE INDEX stays_room ON stays (room_id) WHERE room_id IS NOT NULL;
CREATE INDEX stays_bed ON stays (bed_id) WHERE bed_id IS NOT NULL;

-- A used bed is retired, never deleted, and stays are history. The app role cannot
-- delete either. Deleting an unused room still removes its beds, because Postgres
-- runs the ON DELETE CASCADE with the table owner's rights.
REVOKE DELETE ON beds FROM hostel_app;
REVOKE DELETE ON stays FROM hostel_app;
-- Once written, a stay can only be ended: only ended_on may change.
REVOKE UPDATE ON stays FROM hostel_app;
GRANT UPDATE (ended_on) ON stays TO hostel_app;
