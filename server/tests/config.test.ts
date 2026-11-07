import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const valid = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  JWT_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("accepts valid settings and applies defaults", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("development");
  });

  it("turns PORT into a number", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({ JWT_SECRET: valid.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("names a malformed DATABASE_URL without printing it", () => {
    const password = "Pw#secret";
    let message = "";
    try {
      loadConfig({ ...valid, DATABASE_URL: `postgres://user:${password}@localhost:5432/db` });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL: is not a valid URL/);
    expect(message).not.toContain(password);
  });

  it("rejects a short JWT_SECRET without printing it", () => {
    const secret = "too-short-secret";
    let message = "";
    try {
      loadConfig({ ...valid, JWT_SECRET: secret });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).not.toContain(secret);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadConfig({ ...valid, PORT: "99999" })).toThrow(/PORT/);
  });

  it("has the design's complaint limits by default, and takes others", () => {
    const config = loadConfig(valid);
    expect(config.COMPLAINT_MAX_ACTIVE).toBe(3);
    expect(config.COMPLAINT_MAX_NEW_PER_DAY).toBe(2);

    const changed = loadConfig({ ...valid, COMPLAINT_MAX_ACTIVE: "5", COMPLAINT_MAX_NEW_PER_DAY: "4" });
    expect(changed.COMPLAINT_MAX_ACTIVE).toBe(5);
    expect(changed.COMPLAINT_MAX_NEW_PER_DAY).toBe(4);
  });

  it("rejects a complaint limit below 1 or not a whole number", () => {
    for (const value of ["0", "-1", "2.5", "many"]) {
      expect(() => loadConfig({ ...valid, COMPLAINT_MAX_ACTIVE: value }), value).toThrow(/COMPLAINT_MAX_ACTIVE/);
      expect(() => loadConfig({ ...valid, COMPLAINT_MAX_NEW_PER_DAY: value }), value).toThrow(
        /COMPLAINT_MAX_NEW_PER_DAY/,
      );
    }
  });
});

// Day 8: photos, the usage guard and the jobs endpoint (design doc, sections 8 and 10).
describe("loadConfig: photos, usage guard and jobs", () => {
  const storage = {
    SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_" + "k".repeat(30),
  };
  const production = { ...valid, ...storage, NODE_ENV: "production", JOB_SECRET: "j".repeat(32) };

  function problems(env: Record<string, string>): string {
    try {
      loadConfig(env);
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  }

  it("has the agreed limits by default, and takes others", () => {
    const config = loadConfig(valid);
    expect(config.STORAGE_LIMIT_MB).toBe(450);
    expect(config.EGRESS_LIMIT_MB).toBe(3000);
    expect(config.PHOTO_MAX_BYTES).toBe(1_048_576);
    expect(config.PHOTO_LINK_SECONDS).toBe(60);
    expect(config.STORAGE_BUCKET).toBe("complaint-photos");

    const changed = loadConfig({
      ...valid,
      STORAGE_LIMIT_MB: "900",
      EGRESS_LIMIT_MB: "4500",
      PHOTO_MAX_BYTES: "500000",
      PHOTO_LINK_SECONDS: "120",
      STORAGE_BUCKET: "complaint-photos-dev",
    });
    expect(changed).toMatchObject({
      STORAGE_LIMIT_MB: 900,
      EGRESS_LIMIT_MB: 4500,
      PHOTO_MAX_BYTES: 500_000,
      PHOTO_LINK_SECONDS: 120,
      STORAGE_BUCKET: "complaint-photos-dev",
    });
  });

  it("rejects a limit that is not a positive whole number, or out of range", () => {
    for (const [name, values] of [
      ["STORAGE_LIMIT_MB", ["0", "-1", "2.5", "many"]],
      ["EGRESS_LIMIT_MB", ["0", "-1", "2.5", "many"]],
      // Up to 10 MB: the browser sends about 500 KB, the default cap is 1 MB.
      ["PHOTO_MAX_BYTES", ["0", "1.5", "10485761"]],
      // 10 seconds to 1 hour.
      ["PHOTO_LINK_SECONDS", ["0", "9", "3601", "soon"]],
    ] as const) {
      for (const value of values) {
        expect(problems({ ...valid, [name]: value }), `${name}=${value}`).toMatch(new RegExp(name));
      }
    }
  });

  it("takes a bucket name only in Supabase's form", () => {
    for (const bucket of ["", "Complaint-Photos", "complaint photos", "-photos", "photos/", "a"]) {
      expect(problems({ ...valid, STORAGE_BUCKET: bucket }), bucket).toMatch(/STORAGE_BUCKET/);
    }
  });

  it("runs locally and in tests without storage or a job secret", () => {
    const config = loadConfig(valid);
    expect(config.SUPABASE_URL).toBeUndefined();
    expect(config.SUPABASE_SECRET_KEY).toBeUndefined();
    expect(config.JOB_SECRET).toBeUndefined();
    for (const NODE_ENV of ["development", "test"]) {
      expect(() => loadConfig({ ...valid, NODE_ENV })).not.toThrow();
    }
  });

  it("takes the Supabase URL and key only together", () => {
    expect(loadConfig({ ...valid, ...storage })).toMatchObject(storage);
    expect(problems({ ...valid, SUPABASE_URL: storage.SUPABASE_URL })).toMatch(/SUPABASE_SECRET_KEY/);
    expect(problems({ ...valid, SUPABASE_SECRET_KEY: storage.SUPABASE_SECRET_KEY })).toMatch(/SUPABASE_URL/);
  });

  it("refuses to start in production without storage or a job secret, naming each", () => {
    expect(() => loadConfig(production)).not.toThrow();
    for (const name of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "JOB_SECRET"] as const) {
      const env: Record<string, string> = { ...production };
      delete env[name];
      expect(problems(env), name).toMatch(new RegExp(`${name}: is required in production`));
    }
  });

  it("takes only an https Supabase address with no path", () => {
    for (const url of [
      "http://abcdefghijklmnop.supabase.co",
      "abcdefghijklmnop.supabase.co",
      "https://abcdefghijklmnop.supabase.co/storage/v1",
      "https://abcdefghijklmnop.supabase.co?x=1",
    ]) {
      expect(problems({ ...valid, ...storage, SUPABASE_URL: url }), url).toMatch(/SUPABASE_URL/);
    }
    // A trailing slash is harmless and is dropped.
    expect(loadConfig({ ...valid, ...storage, SUPABASE_URL: `${storage.SUPABASE_URL}/` }).SUPABASE_URL).toBe(
      storage.SUPABASE_URL,
    );
  });

  it("rejects a short key or job secret without printing either", () => {
    const key = "sb_secret_short";
    const jobSecret = "short-job-secret";
    const message = problems({ ...production, SUPABASE_SECRET_KEY: key, JOB_SECRET: jobSecret });
    expect(message).toMatch(/SUPABASE_SECRET_KEY/);
    expect(message).toMatch(/JOB_SECRET/);
    expect(message).not.toContain(key);
    expect(message).not.toContain(jobSecret);
  });
});

// FEES_START_DATE (day 9): the go-live date for fees. No fee row is created for a due date
// before it, and none at all while it is unset (production runs without it until the real
// register is imported).
describe("loadConfig: FEES_START_DATE", () => {
  const problemsWith = (value: string) => {
    try {
      loadConfig({ ...valid, FEES_START_DATE: value });
    } catch (err) {
      return (err as Error).message;
    }
    return "";
  };

  it("is unset by default, also in production, and empty means unset", () => {
    expect(loadConfig(valid).FEES_START_DATE).toBeUndefined();
    expect(loadConfig({ ...valid, FEES_START_DATE: "" }).FEES_START_DATE).toBeUndefined();
    const production = {
      ...valid,
      NODE_ENV: "production",
      SUPABASE_URL: "https://abcd.supabase.co",
      SUPABASE_SECRET_KEY: "s".repeat(40),
      JOB_SECRET: "j".repeat(32),
    };
    expect(loadConfig(production).FEES_START_DATE).toBeUndefined();
  });

  it("takes a real date written as YYYY-MM-DD", () => {
    expect(loadConfig({ ...valid, FEES_START_DATE: "2026-12-01" }).FEES_START_DATE).toBe("2026-12-01");
    for (const value of ["2026-02-30", "01-12-2026", "2026-12", "today", "2026-12-01T00:00:00Z"]) {
      expect(problemsWith(value), value).toMatch(/FEES_START_DATE/);
    }
  });

  it("enforces the Content Security Policy unless CSP_REPORT_ONLY is true", () => {
    expect(loadConfig(valid).CSP_REPORT_ONLY).toBe(false);
    expect(loadConfig({ ...valid, CSP_REPORT_ONLY: "" }).CSP_REPORT_ONLY).toBe(false);
    expect(loadConfig({ ...valid, CSP_REPORT_ONLY: "false" }).CSP_REPORT_ONLY).toBe(false);
    expect(loadConfig({ ...valid, CSP_REPORT_ONLY: "true" }).CSP_REPORT_ONLY).toBe(true);
    expect(() => loadConfig({ ...valid, CSP_REPORT_ONLY: "yes" })).toThrow(/CSP_REPORT_ONLY: must be true or false/);
  });
});

