import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { withHostel } from "../src/db";
import { HttpError } from "../src/lib/http";
import * as deletion from "../src/services/structureDeletion";
import { inRollback, insertOwner, insertStay, insertStructure, insertStudent, testPool } from "./helpers/db";

// services/structureDeletion.ts: deleting a building or room with an email code.
const db = testPool();
afterAll(() => db.end());

const key = deletion.deletionCodeKey("a-test-secret-that-is-at-least-32-chars");

async function refusal(c: PoolClient, call: () => Promise<unknown>): Promise<unknown> {
  await c.query("SAVEPOINT refusal");
  try {
    await call();
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT refusal");
    return err;
  }
  await c.query("RELEASE SAVEPOINT refusal");
  throw new Error("expected the call to be refused, but it succeeded");
}

async function expectRefused(c: PoolClient, call: () => Promise<unknown>, status: number, code: string) {
  const err = await refusal(c, call);
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status, code });
}

const count = async (c: PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, params)).rows[0].n;

// An owner and a building with one floor, room 101 and beds A and B.
async function setUp(c: PoolClient) {
  const owner = await insertOwner(c);
  const place = await insertStructure(c);
  return { owner, ...place };
}

const askBuilding = (c: PoolClient, owner: number, building: number, confirmName: string) =>
  deletion.requestDeletionCode(c, { ownerId: owner, kind: "building", id: building, confirmName, key });

describe("previewDeletion", () => {
  it("counts what a building takes along, and its past and current stays", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      await insertStay(c, { building: p.building, room: p.room, bed: p.bed1, endedOn: "2026-02-01" });
      await insertStay(c, { building: p.building });
      expect(await deletion.previewDeletion(c, "building", p.building)).toEqual({
        kind: "building",
        id: p.building,
        name: p.buildingName,
        confirmName: p.buildingName,
        floors: 1,
        rooms: 1,
        beds: 2,
        pastStays: 1,
        currentStays: 1,
      });
    }));

  it("names a room by its building and number, and asks for the number", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const preview = await deletion.previewDeletion(c, "room", p.room);
      expect(preview).toMatchObject({ name: `${p.buildingName} · Room 101`, confirmName: "101", rooms: 1, beds: 2 });
    }));

  it("refuses an unknown building", () =>
    inRollback(db, async (c) => {
      await expectRefused(c, () => deletion.previewDeletion(c, "building", 999_999_999), 404, "building_not_found");
    }));
});

describe("requestDeletionCode", () => {
  it("makes a 6-digit code for 5 minutes, stored only as a hash", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const issued = await askBuilding(c, p.owner, p.building, `  ${p.buildingName.toUpperCase()} `);
      expect(issued.code).toMatch(/^\d{6}$/);
      expect(issued.resendAfterSeconds).toBe(60);
      const { rows } = await c.query(
        `SELECT target_kind, target_id, octet_length(code_hash) AS bytes,
                round(extract(epoch FROM expires_at - created_at)) AS seconds
         FROM deletion_codes WHERE id = $1`,
        [issued.codeId],
      );
      expect(rows[0]).toEqual({ target_kind: "building", target_id: p.building, bytes: 32, seconds: "300" });
      expect(await count(c, "deletion_codes WHERE code_hash = convert_to($1, 'UTF8')", [issued.code])).toBe(0);
    }));

  it("refuses a wrong name, an occupied building, and a non-owner", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      await expectRefused(c, () => askBuilding(c, p.owner, p.building, "Another"), 400, "confirm_name_mismatch");
      const student = await insertStudent(c);
      await expectRefused(c, () => askBuilding(c, student, p.building, p.buildingName), 403, "forbidden");
      await insertStay(c, { building: p.building });
      await expectRefused(c, () => askBuilding(c, p.owner, p.building, p.buildingName), 409, "building_occupied");
      expect(await count(c, "deletion_codes WHERE owner_id = $1", [p.owner])).toBe(0);
    }));

  it("waits 60 seconds before another code, unless the last one could not be sent", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const first = await askBuilding(c, p.owner, p.building, p.buildingName);
      await expectRefused(c, () => askBuilding(c, p.owner, p.building, p.buildingName), 429, "code_too_soon");
      await deletion.markCodeNotSent(c, first.codeId);
      await askBuilding(c, p.owner, p.building, p.buildingName);
    }));

  it("allows at most 5 codes an hour per owner", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      for (const minutes of [50, 40, 30, 20, 10]) {
        await c.query(
          `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, created_at, expires_at)
           VALUES ($1, $2, 'building', $3, 'x', decode(repeat('ab', 32), 'hex'),
                   now() - make_interval(mins => $4), now() - make_interval(mins => $4) + interval '5 minutes')`,
          [randomUUID(), p.owner, p.building, minutes],
        );
      }
      await expectRefused(c, () => askBuilding(c, p.owner, p.building, p.buildingName), 429, "too_many_codes");
    }));

  it("writes an email with the code in the text, not the subject", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const issued = await askBuilding(c, p.owner, p.building, p.buildingName);
      const email = deletion.deletionEmail(issued);
      expect(email.subject).toContain(p.buildingName);
      expect(email.subject).not.toContain(issued.code);
      expect(email.text).toContain(issued.code);
      expect(email.text).toContain("5 minutes");
    }));
});

describe("deleteWithCode", () => {
  const remove = (c: PoolClient, p: { owner: number; building: number; buildingName: string }, codeId: string, code: string) =>
    deletion.deleteWithCode(c, { ownerId: p.owner, kind: "building", id: p.building, confirmName: p.buildingName, codeId, code, key });

  it("deletes the building, keeps its past stays by name, logs it and uses the code up", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const stay = await insertStay(c, { building: p.building, room: p.room, bed: p.bed1, endedOn: "2026-02-01" });
      const issued = await askBuilding(c, p.owner, p.building, p.buildingName);
      const result = await remove(c, p, issued.codeId, issued.code);
      expect(result).toMatchObject({ ok: true, deleted: { floors: 1, rooms: 1, beds: 2, pastStays: 1 } });
      expect(await count(c, "buildings WHERE id = $1", [p.building])).toBe(0);
      const kept = await c.query("SELECT building_id, building_name, room_number, bed_number FROM stays WHERE id = $1", [stay]);
      expect(kept.rows[0]).toEqual({ building_id: null, building_name: p.buildingName, room_number: "101", bed_number: "A" });
      const log = await c.query(
        "SELECT kind, name, deleted_by, floors, rooms, beds, past_stays, code_id FROM structure_deletions WHERE code_id = $1",
        [issued.codeId],
      );
      expect(log.rows).toEqual([
        { kind: "building", name: p.buildingName, deleted_by: p.owner, floors: 1, rooms: 1, beds: 2, past_stays: 1, code_id: issued.codeId },
      ]);
      await expectRefused(c, () => remove(c, p, issued.codeId, issued.code), 410, "code_expired");
    }));

  it("counts wrong codes, and after 5 the code cannot be used even when right", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const issued = await askBuilding(c, p.owner, p.building, p.buildingName);
      const wrong = issued.code === "000000" ? "111111" : "000000";
      for (const left of [4, 3, 2, 1, 0]) {
        expect(await remove(c, p, issued.codeId, wrong)).toEqual({ ok: false, attemptsLeft: left });
      }
      await expectRefused(c, () => remove(c, p, issued.codeId, issued.code), 410, "code_used_up");
      expect(await count(c, "buildings WHERE id = $1", [p.building])).toBe(1);
    }));

  it("refuses a code once a newer one was sent", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const old = await askBuilding(c, p.owner, p.building, p.buildingName);
      await deletion.markCodeNotSent(c, old.codeId); // lets the next request skip the cooldown
      const newer = await askBuilding(c, p.owner, p.building, p.buildingName);
      await expectRefused(c, () => remove(c, p, old.codeId, old.code), 410, "code_expired");
      expect(await remove(c, p, newer.codeId, newer.code)).toMatchObject({ ok: true });
    }));

  it("refuses an expired code", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const codeId = randomUUID();
      const hash = createHmac("sha256", key).update(`${codeId}:123456`).digest();
      await c.query(
        `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, created_at, expires_at)
         VALUES ($1, $2, 'building', $3, 'x', $4, now() - interval '6 minutes', now() - interval '1 minute')`,
        [codeId, p.owner, p.building, hash],
      );
      await expectRefused(c, () => remove(c, p, codeId, "123456"), 410, "code_expired");
    }));

  it("refuses a code sent for another building, room or owner", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const other = await insertStructure(c);
      const issued = await askBuilding(c, p.owner, other.building, other.buildingName);
      await expectRefused(c, () => remove(c, p, issued.codeId, issued.code), 410, "code_not_valid");
      const otherOwner = await insertOwner(c);
      await expectRefused(
        c,
        () => remove(c, { ...other, owner: otherOwner }, issued.codeId, issued.code),
        410,
        "code_not_valid",
      );
      await expectRefused(
        c,
        () => deletion.deleteWithCode(c, { ownerId: p.owner, kind: "room", id: other.room, confirmName: "101", codeId: issued.codeId, code: issued.code, key }),
        410,
        "code_not_valid",
      );
    }));

  it("refuses when a student moved in after the code was sent, and keeps the code", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const issued = await askBuilding(c, p.owner, p.building, p.buildingName);
      await insertStay(c, { building: p.building });
      await expectRefused(c, () => remove(c, p, issued.codeId, issued.code), 409, "building_occupied");
      const { rows } = await c.query("SELECT consumed_at FROM deletion_codes WHERE id = $1", [issued.codeId]);
      expect(rows[0].consumed_at).toBeNull();
    }));

  it("deletes a room and its beds, keeping the building", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const issued = await deletion.requestDeletionCode(c, { ownerId: p.owner, kind: "room", id: p.room, confirmName: "101", key });
      const result = await deletion.deleteWithCode(c, {
        ownerId: p.owner, kind: "room", id: p.room, confirmName: "101", codeId: issued.codeId, code: issued.code, key,
      });
      expect(result).toMatchObject({ ok: true, deleted: { kind: "room", beds: 2 } });
      expect(await count(c, "rooms WHERE id = $1", [p.room])).toBe(0);
      expect(await count(c, "buildings WHERE id = $1", [p.building])).toBe(1);
    }));

  it("lets only one of two requests with the same code delete", async () => {
    // Committed rows on two connections: the code row lock makes the second wait, then
    // find the code used.
    const p = await withHostel(db, 1, async (tx) => setUp(tx as unknown as PoolClient));
    const issued = await withHostel(db, 1, (tx) => askBuilding(tx as unknown as PoolClient, p.owner, p.building, p.buildingName));
    const attempt = () =>
      withHostel(db, 1, (tx) => remove(tx as unknown as PoolClient, p, issued.codeId, issued.code)).then(
        (r) => (r.ok ? "deleted" : "wrong"),
        (err: HttpError) => err.code,
      );
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.sort()).toEqual(["code_expired", "deleted"]);
  });
});

describe("pruneDeletionCodes", () => {
  it("removes codes older than 7 days and keeps the log", () =>
    inRollback(db, async (c) => {
      const p = await setUp(c);
      const old = randomUUID();
      await c.query(
        `INSERT INTO deletion_codes (id, owner_id, target_kind, target_id, target_name, code_hash, created_at, expires_at)
         VALUES ($1, $2, 'building', $3, 'x', decode(repeat('ab', 32), 'hex'), now() - interval '8 days',
                 now() - interval '8 days' + interval '5 minutes')`,
        [old, p.owner, p.building],
      );
      const fresh = await askBuilding(c, p.owner, p.building, p.buildingName);
      const result = await deletion.pruneDeletionCodes(c, { now: new Date() });
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await count(c, "deletion_codes WHERE id = $1", [old])).toBe(0);
      expect(await count(c, "deletion_codes WHERE id = $1", [fresh.codeId])).toBe(1);
    }));
});
