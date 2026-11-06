import { afterAll, describe, expect, it } from "vitest";
import { inRollback, pgError, testPool } from "./helpers/db";

// The rules the database itself enforces for the owner's payment details (migration 012),
// so they hold even if a service function has a bug. Run as hostel_app, the role the app
// uses, inside transactions that are rolled back. There is one row at most: another test
// file saving details at the same moment makes this file's insert wait, not fail.
const db = testPool();
afterAll(() => db.end());

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

const UPI_ONLY = `INSERT INTO hostel_settings (upi_id) VALUES ($1)`;
const IMAGE = `INSERT INTO hostel_settings (qr_image, qr_mime) VALUES ($1, $2)`;
// How the service saves: create the row the first time, change it after that.
const SAVE = `INSERT INTO hostel_settings (upi_id, upi_payee_name, qr_image, qr_mime) VALUES ($1, $2, $3, $4)
              ON CONFLICT (id) DO UPDATE SET upi_id = EXCLUDED.upi_id, upi_payee_name = EXCLUDED.upi_payee_name,
                qr_image = EXCLUDED.qr_image, qr_mime = EXCLUDED.qr_mime, updated_at = now()`;

const KB_200 = 200 * 1024;

describe("hostel_settings", () => {
  it("creates the one row, id 1, updated now", () =>
    inRollback(db, async (c) => {
      await c.query(UPI_ONLY, ["owner@okaxis"]);
      const { rows } = await c.query(
        `SELECT id, upi_id, upi_payee_name, qr_image, qr_mime, updated_at = now() AS updated_now
         FROM hostel_settings`,
      );
      expect(rows).toEqual([
        { id: 1, upi_id: "owner@okaxis", upi_payee_name: null, qr_image: null, qr_mime: null, updated_now: true },
      ]);
    }));

  it("never holds a second row", () =>
    inRollback(db, async (c) => {
      await c.query(UPI_ONLY, ["owner@okaxis"]);
      expect(await pgError(c, UPI_ONLY, ["other@ybl"])).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "hostel_settings_pkey",
      });
      expect(
        await pgError(c, `INSERT INTO hostel_settings (id, upi_id) VALUES (2, 'other@ybl')`),
      ).toMatchObject({ code: CHECK_VIOLATION, constraint: "hostel_settings_id_check" });
    }));

  it("saves with an upsert, so the first save creates the row and later ones change it", () =>
    inRollback(db, async (c) => {
      await c.query(SAVE, ["owner@okaxis", "Hostel Owner", null, null]);
      await c.query(SAVE, [null, null, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"]);
      const { rows } = await c.query(`SELECT id, upi_id, qr_mime FROM hostel_settings`);
      expect(rows).toEqual([{ id: 1, upi_id: null, qr_mime: "image/jpeg" }]);
    }));

  it("needs a UPI ID or a QR image, or both", () =>
    inRollback(db, async (c) => {
      const err = await pgError(c, SAVE, [null, "Hostel Owner", null, null]);
      expect(err).toMatchObject({ code: CHECK_VIOLATION, constraint: "hostel_settings_something_set" });
      await c.query(SAVE, ["owner@okaxis", null, Buffer.from([1]), "image/png"]);
      const cleared = await pgError(c, `UPDATE hostel_settings SET upi_id = NULL, qr_image = NULL, qr_mime = NULL`);
      expect(cleared).toMatchObject({ code: CHECK_VIOLATION, constraint: "hostel_settings_something_set" });
    }));

  it("takes realistic UPI IDs: one '@' with something on each side, no spaces, 3 to 255 characters", () =>
    inRollback(db, async (c) => {
      for (const upi of ["owner@okaxis", "9876543210@ybl", "raj.kumar-1@okhdfcbank", "a@b", "u@p2p.bank",
                         `x@${"y".repeat(253)}`]) {
        await c.query(SAVE, [upi, null, null, null]);
      }
      for (const [label, upi] of [
        ["no '@'", "ownerokaxis"],
        ["nothing before '@'", "@ybl"],
        ["nothing after '@'", "owner@"],
        ["two '@'", "a@b@c"],
        ["space inside", "own er@ybl"],
        ["leading space", " owner@ybl"],
        ["trailing space", "owner@ybl "],
        ["trailing line break", "owner@ybl\n"],
        ["tab", "owner@\tybl"],
        ["256 characters", `x@${"y".repeat(254)}`],
        ["empty", ""],
      ] as const) {
        const err = await pgError(c, UPI_ONLY, [upi]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint: "hostel_settings_upi_id_check" });
      }
    }));

  it("takes a payee name of 1 to 100 characters, stored trimmed", () =>
    inRollback(db, async (c) => {
      for (const [label, name] of [
        ["empty", ""],
        ["blank", "   "],
        ["101 characters", "x".repeat(101)],
        ["untrimmed", " Hostel Owner"],
      ] as const) {
        const err = await pgError(c, SAVE, ["owner@okaxis", name, null, null]);
        expect(err, label).toMatchObject({
          code: CHECK_VIOLATION,
          constraint: "hostel_settings_upi_payee_name_check",
        });
      }
      for (const name of ["R", "x".repeat(100), "रमेश कुमार"]) {
        await c.query(SAVE, ["owner@okaxis", name, null, null]);
      }
    }));

  it("takes a QR image of 1 byte to 200 KB, always with a JPEG, PNG or WebP type", () =>
    inRollback(db, async (c) => {
      for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
        await c.query(SAVE, [null, null, Buffer.alloc(KB_200), mime]);
      }
      for (const [label, image, mime, constraint] of [
        ["over 200 KB", Buffer.alloc(KB_200 + 1), "image/png", "hostel_settings_qr_image_check"],
        ["empty image", Buffer.alloc(0), "image/png", "hostel_settings_qr_image_check"],
        ["GIF", Buffer.from([1]), "image/gif", "hostel_settings_qr_mime_check"],
        ["SVG", Buffer.from([1]), "image/svg+xml", "hostel_settings_qr_mime_check"],
        ["image without a type", Buffer.from([1]), null, "hostel_settings_qr_mime"],
      ] as const) {
        const err = await pgError(c, IMAGE, [image, mime]);
        expect(err, label).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
      const typeOnly = await pgError(c, `INSERT INTO hostel_settings (upi_id, qr_mime) VALUES ('owner@okaxis', 'image/png')`);
      expect(typeOnly).toMatchObject({ code: CHECK_VIOLATION, constraint: "hostel_settings_qr_mime" });
    }));

  it("lets the app change the details, never the id, and never delete the row", () =>
    inRollback(db, async (c) => {
      await c.query(UPI_ONLY, ["owner@okaxis"]);
      for (const sql of ["UPDATE hostel_settings SET id = 1", "DELETE FROM hostel_settings"]) {
        const err = await pgError(c, sql);
        expect(err.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }));
});
