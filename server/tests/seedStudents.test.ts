import { afterAll, describe, expect, it } from "vitest";
import { SEED_EMAIL_DOMAIN, planSeed, seedStudents } from "../scripts/seedStudents";
import { studentDetailsSchema } from "../src/routes/students";
import { insertOwner, testPool } from "./helpers/db";

// The fake development data in scripts/seedStudents.ts: 200 made-up students, so screens
// and queries are tried at the hostel's real size without any real student's details.
const db = testPool();
afterAll(() => db.end());

const TODAY = "2026-11-04";
const plan = planSeed({ count: 200, today: TODAY });
const active = plan.filter((s) => s.leftOn === null);
const former = plan.filter((s) => s.leftOn !== null);

describe("planSeed", () => {
  it("makes 200 students with unique fake emails, the same every time", () => {
    expect(plan).toHaveLength(200);
    const emails = plan.map((s) => s.details.email);
    expect(new Set(emails).size).toBe(200);
    for (const email of emails) expect(email.endsWith(`@${SEED_EMAIL_DOMAIN}`)).toBe(true);
    expect(planSeed({ count: 200, today: TODAY })).toEqual(plan);
  });

  it("passes the same checks as a real admission", () => {
    for (const { details } of plan) {
      const form = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v ?? undefined]));
      const result = studentDetailsSchema.safeParse({ ...form, monthlyFee: details.monthlyFee });
      expect(result.success, details.email).toBe(true);
    }
  });

  it("mixes categories, food habits, veg days and fees like a real hostel", () => {
    const count = (f: (s: (typeof plan)[number]) => boolean) => plan.filter(f).length;
    const college = count((s) => s.details.category === "college");
    const working = count((s) => s.details.category === "working");
    const other = count((s) => s.details.category === "other");
    expect(college).toBeGreaterThan(working);
    expect(working).toBeGreaterThan(other);
    expect(other).toBeGreaterThan(0);

    expect(count((s) => s.details.foodPreference === "veg")).toBeGreaterThan(50);
    expect(count((s) => s.details.foodPreference === "non_veg")).toBeGreaterThan(50);
    expect(count((s) => s.details.vegDays.length > 0)).toBeGreaterThan(10);
    expect(count((s) => s.details.vegDays.length > 0 && s.details.foodPreference === "veg")).toBe(0);

    const fees = new Set(plan.map((s) => s.details.monthlyFee));
    expect(fees.has(null)).toBe(true);
    expect(fees.size).toBeGreaterThan(5);
  });

  it("joined within the last two years, with plenty of 29ths, 30ths and 31sts", () => {
    for (const { details } of plan) {
      expect(details.joiningDate <= TODAY).toBe(true);
      expect(details.joiningDate >= "2024-11-04").toBe(true);
    }
    const monthEnd = plan.filter((s) => Number(s.details.joiningDate.slice(8)) >= 29);
    expect(monthEnd.length).toBeGreaterThanOrEqual(20);
    for (const day of ["29", "30", "31"]) {
      expect(plan.some((s) => s.details.joiningDate.endsWith(`-${day}`))).toBe(true);
    }
  });

  it("places students at every level, never two in one bed, and 10 have left", () => {
    expect(former).toHaveLength(10);
    for (const s of former) {
      expect(s.leftOn! >= s.details.joiningDate).toBe(true);
      expect(s.place.bed).toBeNull();
    }
    const beds = active.filter((s) => s.place.bed).map((s) => JSON.stringify(s.place));
    expect(new Set(beds).size).toBe(beds.length);
    expect(beds.length).toBeGreaterThan(80);
    expect(active.some((s) => s.place.room && !s.place.bed)).toBe(true);
    expect(active.some((s) => !s.place.room)).toBe(true);
    expect(new Set(plan.map((s) => s.place.building)).size).toBe(2);
  });
});

describe("seedStudents", { timeout: 60_000 }, () => {
  it("writes the plan to the database once, and refuses a second time", async () => {
    const owner = await insertOwner(db);
    const result = await seedStudents(db, owner, "dev-password-hash", plan);
    expect(result).toEqual({ students: 200, former: 10 });

    const { rows } = await db.query(
      `SELECT count(*)::int AS students,
              count(*) FILTER (WHERE u.is_active)::int AS active,
              count(*) FILTER (WHERE u.must_change_password)::int AS must_change,
              count(*) FILTER (WHERE u.password_hash <> 'dev-password-hash')::int AS other_hash,
              count(s.id) FILTER (WHERE s.ended_on IS NULL)::int AS current_stays,
              count(s.id) FILTER (WHERE s.ended_on IS NOT NULL AND NOT u.is_active)::int AS ended_stays
       FROM users u JOIN stays s ON s.student_id = u.id
       WHERE u.email LIKE $1`,
      [`%@${SEED_EMAIL_DOMAIN}`],
    );
    expect(rows[0]).toEqual({
      students: 200,
      active: 190,
      // Seeded students can log in straight away with the development password.
      must_change: 0,
      other_hash: 0,
      current_stays: 190,
      ended_stays: 10,
    });

    const err = await seedStudents(db, owner, "dev-password-hash", plan).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: expect.stringMatching(/already/) });
    const { rows: again } = await db.query("SELECT count(*)::int AS n FROM users WHERE email LIKE $1", [
      `%@${SEED_EMAIL_DOMAIN}`,
    ]);
    expect(again[0].n).toBe(200);
  });
});
