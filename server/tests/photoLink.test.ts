import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newPhotoPath } from "../src/lib/storage";
import { issuePhotoLink, type PhotoFields } from "../src/services/photos";
import { fakeStorage } from "./helpers/fakeStorage";
import { inRollback, testPool } from "./helpers/db";

// issuePhotoLink (Claude, at Nikhil's request; section 12 lists it under "You write").
// Fake storage and a fixed clock; the egress counters use months in 1997, which no other
// test touches. Most tests run in a rolled-back transaction; the race test commits, on
// its own month.
const db = testPool();
afterAll(() => db.end());

const NOW = new Date("1997-06-15T06:30:00Z"); // 15 June 1997, noon in India
const SECONDS = 60;
const SIZE = 480_000;

async function storedPhoto(opts: Partial<PhotoFields> = {}) {
  const storage = fakeStorage();
  const path = newPhotoPath("image/jpeg");
  await storage.upload(path, new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
  const photo: PhotoFields = {
    path,
    sizeBytes: SIZE,
    expiresAt: new Date("1997-06-16T06:30:00Z"),
    deletedAt: null,
    ...opts,
  };
  storage.calls.length = 0; // only the calls made by the code under test
  return { storage, photo };
}

const counter = async (c: Pick<PoolClient, "query">, key: string) =>
  ((await c.query<{ value: number }>("SELECT value FROM usage_counters WHERE key = $1", [key])).rows[0]?.value ?? 0);

describe("issuePhotoLink", () => {
  it("issues a link of the given seconds and adds the photo's size to this India month's egress", () =>
    inRollback(db, async (c) => {
      const { storage, photo } = await storedPhoto();
      const link = await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS });

      expect(link).toBe(`https://fake-storage.test/object/sign/${photo.path}?expires_in=60`);
      expect(storage.calls).toEqual([{ operation: "sign", path: photo.path, seconds: 60 }]);
      expect(await counter(c, "egress:1997-06")).toBe(SIZE);

      // Every view issues a new link and counts again.
      await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS });
      expect(await counter(c, "egress:1997-06")).toBe(2 * SIZE);
      const { rows } = await c.query("SELECT updated_at = now() AS now FROM usage_counters WHERE key = 'egress:1997-06'");
      expect(rows[0].now).toBe(true);
    }));

  it("counts a view at 00:10 India time on 1 July in July", () =>
    inRollback(db, async (c) => {
      const { storage, photo } = await storedPhoto({ expiresAt: new Date("1997-07-01T12:00:00Z") });
      await issuePhotoLink(c, storage, photo, { now: new Date("1997-06-30T18:40:00Z"), seconds: SECONDS });
      expect(await counter(c, "egress:1997-07")).toBe(SIZE);
      expect(await counter(c, "egress:1997-06")).toBe(0);
    }));

  it("gives no link and counts nothing without a photo, or once it is deleted", () =>
    inRollback(db, async (c) => {
      const none = { path: null, sizeBytes: null, expiresAt: null, deletedAt: null };
      const { storage, photo } = await storedPhoto({ deletedAt: new Date("1997-06-15T06:00:00Z") });
      expect(await issuePhotoLink(c, storage, none, { now: NOW, seconds: SECONDS })).toBeNull();
      expect(await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS })).toBeNull();
      expect(storage.calls).toEqual([]);
      expect(await counter(c, "egress:1997-06")).toBe(0);
    }));

  it("gives no link from the expiry time on, even while the deletion is still pending", () =>
    inRollback(db, async (c) => {
      const expiresAt = new Date("1997-06-16T06:30:00Z");
      const { storage, photo } = await storedPhoto({ expiresAt });
      const at = (ms: number) => ({ now: new Date(expiresAt.getTime() + ms), seconds: SECONDS });

      expect(await issuePhotoLink(c, storage, photo, at(-1))).not.toBeNull(); // 1 ms before
      expect(await issuePhotoLink(c, storage, photo, at(0))).toBeNull(); // exactly at expiry
      expect(await issuePhotoLink(c, storage, photo, at(3_600_000))).toBeNull(); // an hour later
      expect(storage.calls).toHaveLength(1);
      expect(storage.objects.has(photo.path!)).toBe(true); // still in storage: deletion pending
      expect(await counter(c, "egress:1997-06")).toBe(SIZE);
    }));

  it("gives no link and counts nothing when storage refuses or does not answer", () =>
    inRollback(db, async (c) => {
      const { storage, photo } = await storedPhoto();
      storage.failNext("sign", 500, null);
      expect(await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS })).toBeNull();
      expect(await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS })).toBeNull();
      expect(await counter(c, "egress:1997-06")).toBe(0);
      // Storage is back: the next view works and counts.
      expect(await issuePhotoLink(c, storage, photo, { now: NOW, seconds: SECONDS })).not.toBeNull();
      expect(await counter(c, "egress:1997-06")).toBe(SIZE);
    }));

  it("gives no link without storage (photo uploads off)", () =>
    inRollback(db, async (c) => {
      const { photo } = await storedPhoto();
      expect(await issuePhotoLink(c, null, photo, { now: NOW, seconds: SECONDS })).toBeNull();
      expect(await counter(c, "egress:1997-06")).toBe(0);
    }));

  it("counts every view when many happen at once (5 rounds of 4)", async () => {
    // Committed, on separate connections, in a month of its own.
    const now = new Date("1997-09-10T06:30:00Z");
    const { storage, photo } = await storedPhoto({ expiresAt: new Date("1997-09-11T06:30:00Z") });
    for (let round = 1; round <= 5; round += 1) {
      const links = await Promise.all(
        Array.from({ length: 4 }, () => issuePhotoLink(db, storage, photo, { now, seconds: SECONDS })),
      );
      expect(links.every((link) => link !== null)).toBe(true);
      expect(await counter(db, "egress:1997-09"), `round ${round}`).toBe(round * 4 * SIZE);
    }
  });
});
