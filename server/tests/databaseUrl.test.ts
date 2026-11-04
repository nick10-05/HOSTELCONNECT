import { describe, expect, it } from "vitest";
import { databaseUrlProblem } from "../src/lib/databaseUrl";

// Made-up values only. The password is distinctive so a test can prove it never
// appears in a message.
const PW = "S3cretPw";
const HOST = "aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=no-verify";
const good = `postgres://hostel_app.abcref:${PW}@${HOST}`;

describe("databaseUrlProblem", () => {
  it("accepts a correct pooler URL, and postgresql:// too", () => {
    expect(databaseUrlProblem(good)).toBeUndefined();
    expect(databaseUrlProblem(good.replace("postgres://", "postgresql://"))).toBeUndefined();
    expect(databaseUrlProblem("postgres://hostel_app:pw@localhost:5432/hostelconnect")).toBeUndefined();
  });

  it("accepts a password whose special characters are percent-encoded", () => {
    expect(databaseUrlProblem(good.replace(PW, encodeURIComponent("Pw#/?x")))).toBeUndefined();
  });

  const cases: [string, string, RegExp][] = [
    ["empty", "   ", /empty/],
    ["wrapped in quotes", `"${good}"`, /quotes/],
    ["NAME= pasted in front", `DATABASE_URL=${good}`, /variable name/],
    ["no postgres:// prefix", good.replace("postgres://", ""), /postgres:\/\//],
    ["a <placeholder> left in", good.replace("aws-0-ap-southeast-1.pooler.supabase.com", "<HOST>"), /placeholder/],
    ["[YOUR-PASSWORD] left in", good.replace(PW, "[YOUR-PASSWORD]"), /placeholder/],
    ["# in the password", good.replace(PW, `${PW}#1`), /percent-encode/],
    ["/ in the password", good.replace(PW, `${PW}/1`), /percent-encode/],
    ["? in the password", good.replace(PW, `${PW}?1`), /percent-encode/],
    ["% that is not %XX", good.replace(PW, `${PW}%zz`), /%/],
    ["no password", good.replace(`:${PW}`, ""), /password/],
    ["no database name", good.replace("/postgres?", "?"), /database name/],
  ];

  it.each(cases)("explains %s without showing the value", (_label, value, expected) => {
    const problem = databaseUrlProblem(value);
    expect(problem).toMatch(expected);
    expect(problem).not.toContain(PW);
    expect(problem).not.toContain("pooler.supabase.com");
  });
});
