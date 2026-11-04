import type { Db } from "../src/db";
import { addDays } from "../src/lib/dates";
import type { StudentDetails } from "../src/routes/students";
import { insertStudentWithStay } from "../src/services/students";

// 200 made-up students for development (design doc, section 12): screens and queries
// are tried at the hostel's real size, and no real student's details ever leave
// production. Used by scripts/seed-200-students.ts; tests/seedStudents.test.ts describes it.
//
// The plan is built from a fixed random seed, so every run (and every developer) gets
// the same students. Nothing here is a real person, email or phone number.

export const SEED_EMAIL_DOMAIN = "seed.hostelconnect.test";

export type SeedPlace = { building: string; floor: number | null; room: string | null; bed: string | null };
export type SeedStudent = { details: StudentDetails; place: SeedPlace; leftOn: string | null };

// Two buildings: A with a ground floor and three floors of five 3-bed rooms (60 beds);
// B with three floors of six 2-bed rooms (36 beds) and two annex rooms with no floor or
// beds. 96 beds for 190 current students, so some live in a room without a bed yet and
// some only in a building, as happens while the owner is still adding detail.
type RoomPlan = { floor: number | null; room: string; beds: string[] };
const LAYOUT: { building: string; rooms: RoomPlan[] }[] = [
  {
    building: "Seed Building A",
    rooms: [0, 1, 2, 3].flatMap((floor) =>
      [1, 2, 3, 4, 5].map((n) => ({ floor, room: `${floor === 0 ? "G" : floor}0${n}`, beds: ["A", "B", "C"] })),
    ),
  },
  {
    building: "Seed Building B",
    rooms: [
      ...[1, 2, 3].flatMap((floor) =>
        [1, 2, 3, 4, 5, 6].map((n) => ({ floor, room: `${floor}0${n}`, beds: ["A", "B"] })),
      ),
      { floor: null, room: "Annex 1", beds: [] },
      { floor: null, room: "Annex 2", beds: [] },
    ],
  },
];

const FIRST = [
  "Aarav", "Aditi", "Akash", "Ananya", "Arjun", "Bhavya", "Chetan", "Deepa", "Dev", "Diya",
  "Farhan", "Gauri", "Harsh", "Isha", "Ishaan", "Jaya", "Karan", "Kavya", "Lakshmi", "Manav",
  "Meera", "Nikhil", "Nisha", "Omkar", "Pooja", "Pranav", "Priya", "Rahul", "Riya", "Rohan",
  "Sana", "Siddharth", "Sneha", "Tanvi", "Tarun", "Uma", "Varun", "Vidya", "Yash", "Zoya",
];
const LAST = [
  "Agarwal", "Bhat", "Chopra", "Das", "Desai", "Fernandes", "Gupta", "Iyer", "Joshi", "Kapoor",
  "Khan", "Kulkarni", "Menon", "Mishra", "Nair", "Patel", "Pillai", "Rao", "Reddy", "Shah",
  "Sharma", "Singh", "Sinha", "Thomas", "Verma",
];
const COLLEGES = [
  ["Seed Engineering College", ["CSE", "ECE", "Mechanical", "Civil"]],
  ["Seed Arts and Science College", ["English", "Physics", "Economics"]],
  ["Seed Medical College", ["MBBS", "Nursing"]],
  ["Seed Commerce College", ["BCom", "BBA"]],
] as const;
const COMPANIES = ["Seed Tech Pvt Ltd", "Seed Bank", "Seed Logistics", "Seed Retail", "Seed Hospital"];
const DESIGNATIONS = ["Developer", "Analyst", "Associate", "Supervisor", "Nurse", null];

// A small, well-known pseudo-random generator (mulberry32): the same seed always gives
// the same numbers, unlike Math.random. Fine for fake data; never for anything secret.
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n); // 0 .. n-1
  const pick = <T>(list: readonly T[]) => list[int(list.length)];
  return { next, int, pick };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The students to create. `today` ('YYYY-MM-DD') anchors the joining dates: all within
// the last two years, every eighth on a 29th, 30th or 31st to exercise the month-end rule.
export function planSeed({ count = 200, today, seed = 2026 }: { count?: number; today: string; seed?: number }) {
  const r = generator(seed);
  const earliest = addDays(today, -730);
  const former = Math.min(10, Math.floor(count / 20));

  // Every bed, in order; current students take them first, leaving a few empty.
  const beds = LAYOUT.flatMap(({ building, rooms }) =>
    rooms.flatMap(({ floor, room, beds: names }) => names.map((bed) => ({ building, floor, room, bed }))),
  );
  const rooms = LAYOUT.flatMap(({ building, rooms }) => rooms.map(({ floor, room }) => ({ building, floor, room })));
  const bedCount = beds.length - 6;

  const plan: SeedStudent[] = [];
  for (let i = 0; i < count; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7 + Math.floor(i / FIRST.length)) % LAST.length];

    let joiningDate: string;
    if (i % 8 === 0) {
      // A month-end day in a month that has it, inside the two-year window.
      const day = 29 + ((i / 8) % 3);
      do {
        const year = Number(today.slice(0, 4)) - r.int(3);
        const month = 1 + r.int(12);
        joiningDate =
          day <= daysInMonth(year, month)
            ? `${year}-${String(month).padStart(2, "0")}-${day}`
            : "";
      } while (!joiningDate || joiningDate < earliest || joiningDate > today);
    } else {
      joiningDate = addDays(today, -r.int(731));
    }

    const kind = i % 10;
    const category = kind < 6 ? "college" : kind < 9 ? "working" : "other";
    const [college, branches] = r.pick(COLLEGES);
    const foodPreference = r.next() < 0.5 ? "veg" : "non_veg";
    let vegDays: number[] = [];
    if (foodPreference === "non_veg" && r.next() < 0.35) {
      vegDays = [...new Set([1 + r.int(7), 1 + r.int(7)])].sort((a, b) => a - b);
    }

    const details: StudentDetails = {
      name: `${first} ${last}`,
      email: `${first}.${last}.${i + 1}@${SEED_EMAIL_DOMAIN}`.toLowerCase(),
      // 98xxxxxxxx and 97xxxxxxxx: valid in form only, made from the row number.
      phone: `98${String(i + 1).padStart(8, "0")}`,
      parentPhone: `97${String(i + 1).padStart(8, "0")}`,
      category,
      collegeName: category === "college" ? college : null,
      branch: category === "college" ? r.pick(branches) : null,
      academicYear: category === "college" ? 1 + r.int(4) : null,
      company: category === "working" ? r.pick(COMPANIES) : null,
      designation: category === "working" ? r.pick(DESIGNATIONS) : null,
      joiningDate,
      foodPreference,
      vegDays,
      // Fees differ per student; a few are not set yet.
      monthlyFee: i % 20 === 0 ? null : 4500 + 250 * r.int(19),
    };

    // The last few have left: they lived in a room (no bed, so no bed is ever shared).
    const isFormer = i >= count - former;
    let place: SeedPlace;
    if (isFormer || (i >= bedCount && i < bedCount + 50)) {
      const room = rooms[i % rooms.length];
      place = { ...room, bed: null };
    } else if (i < bedCount) {
      place = beds[i];
    } else {
      place = { building: LAYOUT[i % 2].building, floor: null, room: null, bed: null };
    }
    const leftOn = isFormer
      ? [addDays(joiningDate, 30 + r.int(270)), today].sort()[0]
      : null;
    plan.push({ details, place, leftOn });
  }
  return plan;
}

// Writes the plan in one transaction, on behalf of the owner `ownerId`. Every seeded
// student gets `passwordHash` and may log in at once (no forced change: these are fake
// accounts for development). Refuses, changing nothing, if seeded students already exist:
// students cannot be deleted, so to start again recreate the local database.
export async function seedStudents(
  db: Db,
  ownerId: number,
  passwordHash: string,
  plan: SeedStudent[],
): Promise<{ students: number; former: number }> {
  const c = await db.connect();
  let broken = false;
  try {
    await c.query("BEGIN");
    const already = await c.query("SELECT 1 FROM users WHERE email LIKE $1 LIMIT 1", [`%@${SEED_EMAIL_DOMAIN}`]);
    if (already.rowCount) {
      throw new Error("Seeded students already exist. Nothing was changed.");
    }

    // Create the layout and remember every id by name.
    const ids = new Map<string, number>();
    const key = (...parts: (string | number | null)[]) => parts.join("|");
    const id = async (sql: string, params: unknown[]) =>
      (await c.query<{ id: number }>(sql, params)).rows[0].id;
    for (const { building, rooms } of LAYOUT) {
      const buildingId = await id("INSERT INTO buildings (name) VALUES ($1) RETURNING id", [building]);
      ids.set(key(building), buildingId);
      for (const { floor, room, beds } of rooms) {
        let floorId: number | null = null;
        if (floor !== null) {
          floorId = ids.get(key(building, floor)) ?? null;
          if (floorId === null) {
            floorId = await id("INSERT INTO floors (building_id, number) VALUES ($1, $2) RETURNING id", [
              buildingId,
              floor,
            ]);
            ids.set(key(building, floor), floorId);
          }
        }
        const roomId = await id(
          "INSERT INTO rooms (building_id, floor_id, room_number) VALUES ($1, $2, $3) RETURNING id",
          [buildingId, floorId, room],
        );
        ids.set(key(building, room), roomId);
        for (const bed of beds) {
          ids.set(
            key(building, room, bed),
            await id("INSERT INTO beds (room_id, bed_number) VALUES ($1, $2) RETURNING id", [roomId, bed]),
          );
        }
      }
    }

    for (const { details, place, leftOn } of plan) {
      const studentId = await insertStudentWithStay(
        c,
        ownerId,
        {
          ...details,
          buildingId: ids.get(key(place.building))!,
          roomId: place.room ? ids.get(key(place.building, place.room))! : null,
          bedId: place.bed ? ids.get(key(place.building, place.room, place.bed))! : null,
        },
        passwordHash,
      );
      if (leftOn) {
        await c.query("UPDATE stays SET ended_on = $2 WHERE student_id = $1 AND ended_on IS NULL", [
          studentId,
          leftOn,
        ]);
        await c.query("UPDATE users SET is_active = false, deactivated_at = $2::date WHERE id = $1", [
          studentId,
          leftOn,
        ]);
      }
    }
    await c.query("UPDATE users SET must_change_password = false WHERE email LIKE $1", [
      `%@${SEED_EMAIL_DOMAIN}`,
    ]);

    await c.query("COMMIT");
    return { students: plan.length, former: plan.filter((s) => s.leftOn).length };
  } catch (err) {
    try {
      await c.query("ROLLBACK");
    } catch {
      broken = true; // keep the original error; drop this connection below
    }
    throw err;
  } finally {
    c.release(broken);
  }
}
