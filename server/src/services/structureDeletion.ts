import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Queryable } from "../db";
import { HttpError } from "../lib/http";

// Deleting a building or room for good, students' past stays included (migration 024).
// tests/structureDeletion.test.ts describes every rule. Two steps, each in the request's
// hostel transaction:
//   1. requestDeletionCode: the owner types the building's name (or the room's number);
//      the server checks it and that nobody lives there now or is booked in, and makes a
//      6-digit code for that one building or room. The route emails it after commit.
//   2. deleteWithCode: the owner sends the name again with the code. The code must be the
//      owner's newest, for this target, unused, under 5 minutes old and under 5 tries.
//      Then the place is deleted, the deletion logged and the code used up, together.
// Locks are always taken in the same order (code, then the building or room), so two
// requests never wait on each other in a circle.

export type TargetKind = "building" | "room";

export const CODE_MINUTES = 5; // also the database's deletion_codes_lifetime check
export const MAX_ATTEMPTS = 5; // also the database's attempts check
export const RESEND_SECONDS = 60;
export const CODES_PER_OWNER_PER_HOUR = 5;
export const CODES_PER_HOSTEL_PER_DAY = 20;
export const CODE_DAYS_KEPT = 7;

// What deleting a building or room takes with it, for the confirm screen and the log.
export type DeletionPreview = {
  kind: TargetKind;
  id: number;
  name: string; // "Block A", or "Block A · Room 101"
  confirmName: string; // what the owner must type: the building's name or the room's number
  floors: number;
  rooms: number;
  beds: number;
  pastStays: number; // ended stays: kept, with their names
  currentStays: number; // current or future stays: the delete is refused while any exist
};

// The key the codes are hashed with, derived from the server's own secret, so there is no
// separate setting to lose. A different JWT_SECRET only makes waiting codes unusable.
export function deletionCodeKey(jwtSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", jwtSecret, "hostelconnect", "deletion codes", 32));
}

const hashCode = (key: Buffer, codeId: string, code: string) =>
  createHmac("sha256", key).update(`${codeId}:${code}`).digest();

const notFound = (kind: TargetKind) =>
  new HttpError(404, `${kind}_not_found`, kind === "building" ? "That building no longer exists." : "That room no longer exists.");

const occupied = (kind: TargetKind) =>
  new HttpError(
    409,
    `${kind}_occupied`,
    `A student lives in this ${kind} now or is booked in. Move them out or transfer them first.`,
  );

// Reads the building or room, locked FOR UPDATE when `lock` (so no student can be placed in
// it until this transaction ends), with what deleting it would take along.
async function readTarget(db: Queryable, kind: TargetKind, id: number, lock: boolean): Promise<DeletionPreview> {
  const forUpdate = lock ? "FOR UPDATE" : "";
  if (kind === "building") {
    const { rows } = await db.query<{ name: string }>(
      `SELECT name FROM buildings WHERE id = $1 AND hostel_id = current_hostel_id() ${forUpdate}`,
      [id],
    );
    if (!rows[0]) throw notFound(kind);
    const counts = await db.query<Omit<DeletionPreview, "kind" | "id" | "name" | "confirmName">>(
      `SELECT (SELECT count(*)::int FROM floors WHERE building_id = $1) AS floors,
              (SELECT count(*)::int FROM rooms WHERE building_id = $1) AS rooms,
              (SELECT count(*)::int FROM beds bd JOIN rooms r ON r.id = bd.room_id WHERE r.building_id = $1) AS beds,
              (SELECT count(*)::int FROM stays WHERE building_id = $1 AND ended_on IS NOT NULL) AS "pastStays",
              (SELECT count(*)::int FROM stays WHERE building_id = $1 AND ended_on IS NULL) AS "currentStays"`,
      [id],
    );
    return { kind, id, name: rows[0].name, confirmName: rows[0].name, ...counts.rows[0] };
  }
  const { rows } = await db.query<{ roomNumber: string; buildingName: string }>(
    `SELECT r.room_number AS "roomNumber", b.name AS "buildingName"
     FROM rooms r JOIN buildings b ON b.id = r.building_id
     WHERE r.id = $1 AND r.hostel_id = current_hostel_id() ${lock ? "FOR UPDATE OF r" : ""}`,
    [id],
  );
  if (!rows[0]) throw notFound(kind);
  const counts = await db.query<{ beds: number; pastStays: number; currentStays: number }>(
    `SELECT (SELECT count(*)::int FROM beds WHERE room_id = $1) AS beds,
            (SELECT count(*)::int FROM stays WHERE room_id = $1 AND ended_on IS NOT NULL) AS "pastStays",
            (SELECT count(*)::int FROM stays WHERE room_id = $1 AND ended_on IS NULL) AS "currentStays"`,
    [id],
  );
  return {
    kind,
    id,
    name: `${rows[0].buildingName} · Room ${rows[0].roomNumber}`,
    confirmName: rows[0].roomNumber,
    floors: 0,
    rooms: 1,
    ...counts.rows[0],
  };
}

// The typed name must be the building's name (or the room's number), ignoring case and
// the spaces around it.
function checkConfirmName(target: DeletionPreview, typed: string): void {
  if (typed.trim().toLowerCase() !== target.confirmName.trim().toLowerCase()) {
    throw new HttpError(
      400,
      "confirm_name_mismatch",
      target.kind === "building"
        ? `Type the building's name, ${target.confirmName}, to confirm.`
        : `Type the room number, ${target.confirmName}, to confirm.`,
    );
  }
}

export async function previewDeletion(db: Queryable, kind: TargetKind, id: number): Promise<DeletionPreview> {
  return readTarget(db, kind, id, false);
}

export type IssuedCode = {
  codeId: string;
  code: string; // only for the email; never sent to the browser or logged
  expiresAt: string;
  resendAfterSeconds: number;
  ownerEmail: string;
  hostelName: string;
  target: DeletionPreview;
};

export async function requestDeletionCode(
  db: Queryable,
  input: { ownerId: number; kind: TargetKind; id: number; confirmName: string; key: Buffer },
): Promise<IssuedCode> {
  // The owner's row first: two "Send code" taps at once queue here, so the second sees the
  // first's code and waits out the cooldown.
  const owner = await db.query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 AND role = 'owner' AND hostel_id = current_hostel_id() FOR UPDATE",
    [input.ownerId],
  );
  if (!owner.rows[0]) throw new HttpError(403, "forbidden", "Only the hostel's owner may delete.");

  const target = await readTarget(db, input.kind, input.id, true);
  checkConfirmName(target, input.confirmName);
  if (target.currentStays > 0) throw occupied(input.kind);

  const limits = await db.query<{ waitSeconds: number | null; lastHour: number; lastDay: number }>(
    `SELECT (SELECT ceil($2 - extract(epoch FROM now() - max(created_at)))::int
             FROM deletion_codes WHERE owner_id = $1 AND send_failed_at IS NULL) AS "waitSeconds",
            (SELECT count(*)::int FROM deletion_codes
             WHERE owner_id = $1 AND created_at > now() - interval '1 hour') AS "lastHour",
            (SELECT count(*)::int FROM deletion_codes
             WHERE hostel_id = current_hostel_id() AND created_at > now() - interval '1 day') AS "lastDay"`,
    [input.ownerId, RESEND_SECONDS],
  );
  const { waitSeconds, lastHour, lastDay } = limits.rows[0];
  if (waitSeconds !== null && waitSeconds > 0) {
    throw new HttpError(429, "code_too_soon", `A code was just sent. You can ask for a new one in ${waitSeconds} seconds.`);
  }
  if (lastHour >= CODES_PER_OWNER_PER_HOUR || lastDay >= CODES_PER_HOSTEL_PER_DAY) {
    throw new HttpError(429, "too_many_codes", "Too many codes were asked for. Try again later.");
  }

  // Only the newest code works: any earlier one still open is replaced.
  await db.query(
    `UPDATE deletion_codes SET superseded_at = now()
     WHERE owner_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL AND send_failed_at IS NULL`,
    [input.ownerId],
  );

  const codeId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const inserted = await db.query<{ expiresAt: string }>(
    `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAt"`,
    [codeId, input.ownerId, input.kind, input.id, target.name, hashCode(input.key, codeId, code), CODE_MINUTES],
  );
  const hostel = await db.query<{ name: string }>("SELECT name FROM hostels WHERE id = current_hostel_id()");

  return {
    codeId,
    code,
    expiresAt: inserted.rows[0].expiresAt,
    resendAfterSeconds: RESEND_SECONDS,
    ownerEmail: owner.rows[0].email,
    hostelName: hostel.rows[0]?.name ?? "your hostel",
    target,
  };
}

// The email could not be sent: the code can never be used, and the cooldown does not apply.
export async function markCodeNotSent(db: Queryable, codeId: string): Promise<void> {
  await db.query("UPDATE deletion_codes SET send_failed_at = now() WHERE id = $1 AND send_failed_at IS NULL", [codeId]);
}

export function deletionEmail(issued: IssuedCode): { subject: string; text: string } {
  const what = issued.target.kind === "building" ? "building" : "room";
  return {
    subject: `HostelConnect: code to delete ${issued.target.name}`,
    text: [
      `Your code to permanently delete the ${what} ${issued.target.name} in ${issued.hostelName} is:`,
      "",
      `    ${issued.code}`,
      "",
      `It works once, for the next ${CODE_MINUTES} minutes. Students' past stays keep the ${what}'s name;`,
      `the ${what} itself${issued.target.kind === "building" ? ", its floors, rooms and beds" : " and its beds"} cannot be brought back.`,
      "",
      "If you did not ask for this, do not share the code with anyone. Sign in to HostelConnect",
      "and use \"Sign out everywhere\" in Settings.",
    ].join("\n"),
  };
}

export type DeleteResult =
  | { ok: true; deleted: DeletionPreview }
  | { ok: false; attemptsLeft: number };

const CHECK_VIOLATION = "23514";

export async function deleteWithCode(
  db: Queryable,
  input: { ownerId: number; kind: TargetKind; id: number; confirmName: string; codeId: string; code: string; key: Buffer },
): Promise<DeleteResult> {
  const found = await db.query<{
    ownerId: number;
    targetKind: string;
    targetId: number;
    codeHash: Buffer;
    attempts: number;
    closed: boolean;
    expired: boolean;
  }>(
    `SELECT owner_id AS "ownerId", target_kind AS "targetKind", target_id AS "targetId", code_hash AS "codeHash",
            attempts, (consumed_at IS NOT NULL OR superseded_at IS NOT NULL OR send_failed_at IS NOT NULL) AS closed,
            now() >= expires_at AS expired
     FROM deletion_codes WHERE id = $1 AND hostel_id = current_hostel_id() FOR UPDATE`,
    [input.codeId],
  );
  const row = found.rows[0];
  if (!row || row.ownerId !== input.ownerId || row.targetKind !== input.kind || row.targetId !== input.id) {
    throw new HttpError(410, "code_not_valid", "This code is not for this deletion. Ask for a new code.");
  }
  if (row.closed || row.expired) {
    throw new HttpError(410, "code_expired", "This code has expired or was already used. Ask for a new code.");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new HttpError(410, "code_used_up", "Too many wrong tries for this code. Ask for a new code.");
  }

  const given = hashCode(input.key, input.codeId, input.code);
  if (!timingSafeEqual(given, row.codeHash)) {
    // Recorded even though the request fails: the route commits this before answering.
    const tried = await db.query<{ attempts: number }>(
      "UPDATE deletion_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts",
      [input.codeId],
    );
    return { ok: false, attemptsLeft: MAX_ATTEMPTS - tried.rows[0].attempts };
  }

  const target = await readTarget(db, input.kind, input.id, true);
  checkConfirmName(target, input.confirmName);
  if (target.currentStays > 0) throw occupied(input.kind);

  const table = input.kind === "building" ? "buildings" : "rooms";
  try {
    await db.query("SAVEPOINT structure_delete");
    await db.query(`DELETE FROM ${table} WHERE id = $1 AND hostel_id = current_hostel_id()`, [input.id]);
    await db.query("RELEASE SAVEPOINT structure_delete");
  } catch (err) {
    // The stays' checks (migration 024) refuse if a current stay appeared after all.
    if ((err as { code?: string }).code === CHECK_VIOLATION) {
      await db.query("ROLLBACK TO SAVEPOINT structure_delete");
      throw occupied(input.kind);
    }
    throw err;
  }

  await db.query(
    `INSERT INTO structure_deletions (kind, name, deleted_by, floors, rooms, beds, past_stays, code_id, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [input.kind, target.name, input.ownerId, target.floors, target.rooms, target.beds, target.pastStays, input.codeId],
  );
  await db.query("UPDATE deletion_codes SET consumed_at = now() WHERE id = $1", [input.codeId]);
  return { ok: true, deleted: target };
}

// Run by the hourly jobs: codes older than CODE_DAYS_KEPT days go; the deletions log stays.
export async function pruneDeletionCodes(db: Queryable, opts: { now: Date }): Promise<{ deleted: number }> {
  const { rowCount } = await db.query(
    `DELETE FROM deletion_codes WHERE hostel_id = current_hostel_id() AND created_at < $1::timestamptz - make_interval(days => $2)`,
    [opts.now, CODE_DAYS_KEPT],
  );
  return { deleted: rowCount ?? 0 };
}
