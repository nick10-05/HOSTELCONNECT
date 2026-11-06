import { isPhotoPath, StorageError, type PhotoStorage, type PhotoType } from "../../src/lib/storage";

// An in-memory PhotoStorage for tests (section 12: "tests with fake storage"). It keeps
// the objects in a Map, records every call, and can be told to fail, so the upload route,
// the signed links and the expiry job's retries can be tested without Supabase.
// tests/fakeStorage.test.ts describes it.
export type FakeStorage = PhotoStorage & {
  objects: Map<string, { bytes: Uint8Array; type: PhotoType }>;
  calls: Array<{ operation: "upload" | "sign" | "remove"; path: string; seconds?: number }>;
  // The next calls of that operation fail, each with this status (null: no answer).
  failNext(operation: StorageError["operation"], ...statuses: Array<number | null>): void;
};

export function fakeStorage(): FakeStorage {
  const objects: FakeStorage["objects"] = new Map();
  const calls: FakeStorage["calls"] = [];
  const failures: Record<StorageError["operation"], Array<number | null>> = { upload: [], sign: [], remove: [] };

  // Records the call and throws if a failure is queued for it. Like the real module, a
  // name that is not a photo object name is a bug in the caller.
  function begin(operation: StorageError["operation"], path: string, seconds?: number): void {
    if (!isPhotoPath(path)) throw new Error("not a photo object name");
    calls.push(seconds === undefined ? { operation, path } : { operation, path, seconds });
    if (failures[operation].length) throw new StorageError(operation, failures[operation].shift()!);
  }

  return {
    objects,
    calls,
    failNext(operation, ...statuses) {
      failures[operation].push(...statuses);
    },
    async upload(path, bytes, type) {
      begin("upload", path);
      // Supabase refuses to overwrite (x-upsert: false) with 409.
      if (objects.has(path)) throw new StorageError("upload", 409);
      objects.set(path, { bytes, type });
    },
    async signedUrl(path, seconds) {
      begin("sign", path, seconds);
      if (!objects.has(path)) throw new StorageError("sign", 400);
      return `https://fake-storage.test/object/sign/${path}?expires_in=${seconds}`;
    },
    async remove(path) {
      begin("remove", path);
      return objects.delete(path);
    },
  };
}
