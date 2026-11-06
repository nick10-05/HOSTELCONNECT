import { randomUUID } from "node:crypto";
import type { Config } from "../config";

// Complaint photos in a private Supabase Storage bucket (design doc, sections 8 to 10),
// through Supabase's REST API with plain fetch (decided on day 8: no Supabase SDK).
// The secret key is sent only to Supabase and never reaches the browser. Nothing here
// logs, and no error message carries the key, a signed link or Supabase's answer text.

// The three photo types the server accepts (checked by content before upload), and the
// extension each is stored under.
export const PHOTO_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type PhotoType = keyof typeof PHOTO_TYPES;

// What the rest of the server needs from storage. Tests use a fake (tests/helpers/
// fakeStorage.ts) with the same shape.
export interface PhotoStorage {
  // Stores a new object; never overwrites one.
  upload(path: string, bytes: Uint8Array, type: PhotoType): Promise<void>;
  // A link anyone holding it can open for `seconds`, then never again.
  signedUrl(path: string, seconds: number): Promise<string>;
  // Deletes the object. true: storage deleted it; false: storage did not have it.
  remove(path: string): Promise<boolean>;
}

// Storage refused or did not answer. `status` is the HTTP status, or null when no
// answer came (network failure or the time limit).
export class StorageError extends Error {
  constructor(
    readonly operation: "upload" | "sign" | "remove",
    readonly status: number | null,
  ) {
    super(`Storage ${operation} failed (${status === null ? "no answer" : `status ${status}`})`);
    this.name = "StorageError";
  }
}

// Random object names (section 8): complaints/<random UUID>.<extension>. Nobody can guess
// one, and the name says nothing about the student or the complaint.
const PHOTO_PATH = /^complaints\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function newPhotoPath(type: PhotoType): string {
  return `complaints/${randomUUID()}.${PHOTO_TYPES[type]}`;
}

export function isPhotoPath(path: string): boolean {
  return PHOTO_PATH.test(path);
}

// Each request gets this long; the hourly job must not hang on one photo.
const TIME_LIMIT_MS = 15_000;

type Options = {
  url: string; // the project address, e.g. https://abcd.supabase.co, no trailing slash
  secretKey: string;
  bucket: string;
  fetch?: typeof globalThis.fetch; // tests pass a fake
};

export function supabaseStorage({ url, secretKey, bucket, fetch = globalThis.fetch }: Options): PhotoStorage {
  const api = `${url}/storage/v1`;
  // The newer sb_secret_ keys go in apikey; the older service_role key also needs the
  // Authorization header. Sending both works for either.
  const auth = { apikey: secretKey, authorization: `Bearer ${secretKey}` };

  // Sends one request. Any failure to get an answer becomes a StorageError with no
  // status; the original error is dropped, since its text could repeat what was sent.
  async function send(operation: StorageError["operation"], target: string, init: RequestInit) {
    try {
      return await fetch(target, { ...init, signal: AbortSignal.timeout(TIME_LIMIT_MS) });
    } catch {
      throw new StorageError(operation, null);
    }
  }

  // Reads a successful JSON answer; anything else is the operation's StorageError.
  async function answer(operation: StorageError["operation"], res: Response): Promise<unknown> {
    if (!res.ok) throw new StorageError(operation, res.status);
    try {
      return await res.json();
    } catch {
      throw new StorageError(operation, res.status);
    }
  }

  function checkPath(path: string): void {
    if (!isPhotoPath(path)) throw new Error("not a photo object name");
  }

  return {
    async upload(path, bytes, type) {
      checkPath(path);
      const res = await send("upload", `${api}/object/${bucket}/${path}`, {
        method: "POST",
        headers: { ...auth, "content-type": type, "x-upsert": "false" },
        // TypeScript's fetch types allow only bytes over a plain ArrayBuffer; an upload's
        // bytes always are one (never shared memory), so this only narrows the type.
        body: bytes as Uint8Array<ArrayBuffer>,
      });
      if (!res.ok) throw new StorageError("upload", res.status);
    },

    async signedUrl(path, seconds) {
      checkPath(path);
      const res = await send("sign", `${api}/object/sign/${bucket}/${path}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: seconds }),
      });
      const body = await answer("sign", res);
      // Supabase answers with a path below /storage/v1, e.g. /object/sign/<bucket>/...?token=
      const signed = (body as { signedURL?: unknown } | null)?.signedURL;
      if (typeof signed !== "string" || !signed.startsWith(`/object/sign/${bucket}/${path}?`)) {
        throw new StorageError("sign", res.status);
      }
      return `${api}${signed}`;
    },

    async remove(path) {
      checkPath(path);
      // The bulk delete answers 200 with the objects it deleted, and an empty list when
      // the object was already gone. (Deleting one object by its own address answers an
      // error for a missing object instead, which would look like a failure.)
      const res = await send("remove", `${api}/object/${bucket}`, {
        method: "DELETE",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [path] }),
      });
      const body = await answer("remove", res);
      if (!Array.isArray(body)) throw new StorageError("remove", res.status);
      return body.some((object) => (object as { name?: unknown } | null)?.name === path);
    },
  };
}

// The real storage when Supabase is configured; null otherwise, which switches photo
// uploads off (local development without the dev bucket's settings, and tests).
export function storageFromConfig(config: Config, fetch?: typeof globalThis.fetch): PhotoStorage | null {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) return null;
  return supabaseStorage({
    url: config.SUPABASE_URL,
    secretKey: config.SUPABASE_SECRET_KEY,
    bucket: config.STORAGE_BUCKET,
    fetch,
  });
}
