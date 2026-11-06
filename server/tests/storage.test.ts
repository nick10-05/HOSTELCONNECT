import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  isPhotoPath,
  newPhotoPath,
  StorageError,
  storageFromConfig,
  supabaseStorage,
  type PhotoStorage,
} from "../src/lib/storage";

// The storage module talks to Supabase Storage's REST API with plain fetch (decided on
// day 8). These tests replace fetch with a recorder, so nothing reaches the network:
// they check the exact requests, how answers are read, and that neither the secret key
// nor a signed link ever appears in an error message (section 8: never log either).

const URL_BASE = "https://abcdefghijklmnop.supabase.co";
const KEY = "sb_secret_" + "k".repeat(30);
const BUCKET = "complaint-photos";
const PATH = "complaints/0b9c7a52-3f1e-4c2a-9d4b-5e6f7a8b9c0d.jpg";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.signed-token-part";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: unknown };

// A stand-in for fetch: records each request and answers with the next prepared answer.
function fakeFetch(...answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
      signal: init.signal,
    });
    const answer = answers.shift();
    if (!answer) throw new Error("fakeFetch: no answer prepared");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function storageWith(...answers: Array<Response | Error>) {
  const { fetch, calls } = fakeFetch(...answers);
  return { storage: supabaseStorage({ url: URL_BASE, secretKey: KEY, bucket: BUCKET, fetch }), calls };
}

// Runs a call that must fail and returns its StorageError.
async function storageError(call: Promise<unknown>): Promise<StorageError> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }
  throw new Error("expected the storage call to fail");
}

describe("photo object names", () => {
  it("are complaints/<random UUID>.<extension of the type>", () => {
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    expect(newPhotoPath("image/jpeg")).toMatch(new RegExp(`^complaints/${uuid}\\.jpg$`));
    expect(newPhotoPath("image/png")).toMatch(new RegExp(`^complaints/${uuid}\\.png$`));
    expect(newPhotoPath("image/webp")).toMatch(new RegExp(`^complaints/${uuid}\\.webp$`));
    expect(newPhotoPath("image/jpeg")).not.toBe(newPhotoPath("image/jpeg"));
  });

  it("are recognised exactly, so nothing else can be sent to storage", () => {
    expect(isPhotoPath(PATH)).toBe(true);
    expect(isPhotoPath(newPhotoPath("image/webp"))).toBe(true);
    for (const path of [
      "",
      "complaints/",
      "complaints/photo.jpg",
      "0b9c7a52-3f1e-4c2a-9d4b-5e6f7a8b9c0d.jpg",
      "complaints/0b9c7a52-3f1e-4c2a-9d4b-5e6f7a8b9c0d.gif",
      "complaints/0B9C7A52-3F1E-4C2A-9D4B-5E6F7A8B9C0D.jpg",
      "complaints/../0b9c7a52-3f1e-4c2a-9d4b-5e6f7a8b9c0d.jpg",
      "other/0b9c7a52-3f1e-4c2a-9d4b-5e6f7a8b9c0d.jpg",
      `${PATH}?x=1`,
      `${PATH}\n`,
    ]) {
      expect(isPhotoPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});

describe("supabaseStorage", () => {
  it("uploads with the key, the type and no overwrite", async () => {
    const { storage, calls } = storageWith(json(200, { Key: `${BUCKET}/${PATH}` }));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    await storage.upload(PATH, bytes, "image/jpeg");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${URL_BASE}/storage/v1/object/${BUCKET}/${PATH}`,
      method: "POST",
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        "content-type": "image/jpeg",
        "x-upsert": "false",
      },
      body: bytes,
    });
  });

  it("asks for a signed link that lasts the given seconds and returns its full address", async () => {
    const signedURL = `/object/sign/${BUCKET}/${PATH}?token=${TOKEN}`;
    const { storage, calls } = storageWith(json(200, { signedURL }));
    const link = await storage.signedUrl(PATH, 60);

    expect(link).toBe(`${URL_BASE}/storage/v1${signedURL}`);
    expect(calls[0]).toMatchObject({
      url: `${URL_BASE}/storage/v1/object/sign/${BUCKET}/${PATH}`,
      method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    });
    expect(JSON.parse(String(calls[0].body))).toEqual({ expiresIn: 60 });
  });

  it("deletes one object and says whether storage had it", async () => {
    const { storage, calls } = storageWith(
      json(200, [{ name: PATH, bucket_id: BUCKET }]),
      json(200, []), // already gone: Supabase answers 200 with an empty list
    );
    expect(await storage.remove(PATH)).toBe(true);
    expect(await storage.remove(PATH)).toBe(false);

    expect(calls[0]).toMatchObject({
      url: `${URL_BASE}/storage/v1/object/${BUCKET}`,
      method: "DELETE",
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    });
    expect(JSON.parse(String(calls[0].body))).toEqual({ prefixes: [PATH] });
  });

  it("gives every request a time limit", async () => {
    const { storage, calls } = storageWith(
      json(200, {}),
      json(200, { signedURL: `/object/sign/${BUCKET}/${PATH}?token=${TOKEN}` }),
      json(200, []),
    );
    await storage.upload(PATH, new Uint8Array([1]), "image/png");
    await storage.signedUrl(PATH, 60);
    await storage.remove(PATH);
    for (const call of calls) expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses anything but a photo object name, without calling storage", async () => {
    const { storage, calls } = storageWith();
    for (const path of ["complaints/photo.jpg", "../secret", `${PATH}/../x`]) {
      await expect(storage.upload(path, new Uint8Array([1]), "image/jpeg")).rejects.toThrow(/not a photo object name/);
      await expect(storage.signedUrl(path, 60)).rejects.toThrow(/not a photo object name/);
      await expect(storage.remove(path)).rejects.toThrow(/not a photo object name/);
    }
    expect(calls).toHaveLength(0);
  });

  it("turns a refusal from storage into a StorageError with the operation and status", async () => {
    const answers = [
      json(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" }),
      json(400, { statusCode: "404", error: "not_found", message: "Object not found" }),
      json(500, { message: "Internal" }),
      json(403, { message: "new row violates row-level security policy" }),
    ];
    const { storage } = storageWith(...answers);

    const upload = await storageError(storage.upload(PATH, new Uint8Array([1]), "image/jpeg"));
    expect(upload).toMatchObject({ operation: "upload", status: 409 });
    expect(upload.message).toBe("Storage upload failed (status 409)");

    expect(await storageError(storage.signedUrl(PATH, 60))).toMatchObject({ operation: "sign", status: 400 });
    expect(await storageError(storage.remove(PATH))).toMatchObject({ operation: "remove", status: 500 });
    expect(await storageError(storage.upload(PATH, new Uint8Array([1]), "image/jpeg"))).toMatchObject({
      operation: "upload",
      status: 403,
    });
  });

  it("turns no answer (network failure, time limit) into a StorageError with no status", async () => {
    const { storage } = storageWith(
      new TypeError("fetch failed"),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      new TypeError("fetch failed"),
    );
    const upload = await storageError(storage.upload(PATH, new Uint8Array([1]), "image/jpeg"));
    expect(upload).toMatchObject({ operation: "upload", status: null });
    expect(upload.message).toBe("Storage upload failed (no answer)");
    expect(await storageError(storage.signedUrl(PATH, 60))).toMatchObject({ operation: "sign", status: null });
    expect(await storageError(storage.remove(PATH))).toMatchObject({ operation: "remove", status: null });
  });

  it("treats an answer it cannot read as a failure", async () => {
    const { storage } = storageWith(
      json(200, {}), // no signedURL
      json(200, { signedURL: `https://elsewhere.example/${TOKEN}` }), // not a Supabase path
      new Response("not json", { status: 200 }),
      json(200, { deleted: PATH }), // not a list
    );
    expect(await storageError(storage.signedUrl(PATH, 60))).toMatchObject({ operation: "sign", status: 200 });
    expect(await storageError(storage.signedUrl(PATH, 60))).toMatchObject({ operation: "sign", status: 200 });
    expect(await storageError(storage.remove(PATH))).toMatchObject({ operation: "remove", status: 200 });
    expect(await storageError(storage.remove(PATH))).toMatchObject({ operation: "remove", status: 200 });
  });

  it("never puts the secret key, a signed link or the answer's text in an error", async () => {
    const echo = { message: `bad key ${KEY}`, signedURL: `/object/sign/${BUCKET}/${PATH}?token=${TOKEN}` };
    const { storage } = storageWith(
      json(401, echo),
      json(401, echo),
      json(401, echo),
      json(200, { signedURL: `https://elsewhere.example/?token=${TOKEN}` }),
      new TypeError(`fetch failed for ${KEY}`),
    );
    const errors = [
      await storageError(storage.upload(PATH, new Uint8Array([1]), "image/jpeg")),
      await storageError(storage.signedUrl(PATH, 60)),
      await storageError(storage.remove(PATH)),
      await storageError(storage.signedUrl(PATH, 60)),
      await storageError(storage.remove(PATH)),
    ];
    for (const err of errors) {
      const everything = `${err.message} ${err.stack ?? ""} ${String(err.cause ?? "")} ${JSON.stringify(err)}`;
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain("bad key");
    }
  });
});

describe("storageFromConfig", () => {
  const valid = { DATABASE_URL: "postgres://user:pw@localhost:5432/db", JWT_SECRET: "a".repeat(32) };

  it("is null without Supabase settings, so photo uploads are off", () => {
    expect(storageFromConfig(loadConfig(valid))).toBeNull();
  });

  it("uses the configured project, key and bucket", async () => {
    const config = loadConfig({
      ...valid,
      SUPABASE_URL: URL_BASE,
      SUPABASE_SECRET_KEY: KEY,
      STORAGE_BUCKET: "complaint-photos-dev",
    });
    const { fetch, calls } = fakeFetch(json(200, []));
    const storage = storageFromConfig(config, fetch) as PhotoStorage;
    await storage.remove(PATH);
    expect(calls[0].url).toBe(`${URL_BASE}/storage/v1/object/complaint-photos-dev`);
    expect(calls[0].headers.apikey).toBe(KEY);
  });
});
