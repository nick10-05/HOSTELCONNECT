import { describe, expect, it } from "vitest";
import { newPhotoPath, StorageError } from "../src/lib/storage";
import { fakeStorage } from "./helpers/fakeStorage";

// The fake storage behaves like Supabase where later tests depend on it: no overwrite,
// no link for a missing object, delete says whether the object existed, and queued
// failures happen once each, in order.
describe("fakeStorage", () => {
  it("stores, links and deletes, recording each call", async () => {
    const storage = fakeStorage();
    const path = newPhotoPath("image/png");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    await storage.upload(path, bytes, "image/png");
    expect(storage.objects.get(path)).toEqual({ bytes, type: "image/png" });
    expect(await storage.signedUrl(path, 60)).toContain(path);
    expect(await storage.remove(path)).toBe(true);
    expect(await storage.remove(path)).toBe(false);
    expect(storage.objects.size).toBe(0);

    expect(storage.calls).toEqual([
      { operation: "upload", path },
      { operation: "sign", path, seconds: 60 },
      { operation: "remove", path },
      { operation: "remove", path },
    ]);
  });

  it("refuses to overwrite an object or link a missing one, as Supabase does", async () => {
    const storage = fakeStorage();
    const path = newPhotoPath("image/jpeg");
    await storage.upload(path, new Uint8Array([1]), "image/jpeg");
    await expect(storage.upload(path, new Uint8Array([2]), "image/jpeg")).rejects.toMatchObject({
      operation: "upload",
      status: 409,
    });
    await expect(storage.signedUrl(newPhotoPath("image/jpeg"), 60)).rejects.toBeInstanceOf(StorageError);
  });

  it("fails the queued calls once each, in order, then works again", async () => {
    const storage = fakeStorage();
    const path = newPhotoPath("image/webp");
    await storage.upload(path, new Uint8Array([1]), "image/webp");

    storage.failNext("remove", 500, null);
    await expect(storage.remove(path)).rejects.toMatchObject({ operation: "remove", status: 500 });
    await expect(storage.remove(path)).rejects.toMatchObject({ operation: "remove", status: null });
    expect(storage.objects.has(path)).toBe(true);
    expect(await storage.remove(path)).toBe(true);
  });

  it("refuses anything but a photo object name", async () => {
    const storage = fakeStorage();
    await expect(storage.remove("complaints/photo.jpg")).rejects.toThrow(/not a photo object name/);
    expect(storage.calls).toHaveLength(0);
  });
});
