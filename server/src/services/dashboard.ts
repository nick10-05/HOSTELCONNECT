import type { Queryable } from "../db";

// The owner's dashboard (design doc, section 9): every card in one answer, so the home
// page is one request even on a server that has just woken up. Day 5 adds the students
// and rejoin requests cards, day 6 the complaints card; later days add theirs as new keys.
// tests/dashboard.test.ts describes it.

export type BuildingCard = {
  id: number;
  name: string;
  // Active students whose current stay is in this building, including those who have
  // not arrived yet (decided on day 5: they are booked and their bed is held).
  students: number;
  joiningLater: number; // of those, the ones whose stay starts after today
  // Beds that are not retired; null when the building has no beds yet. A bed is
  // occupied while a current stay holds it, the same rule as stays_one_current_per_bed.
  beds: { total: number; occupied: number; vacant: number } | null;
};

export type Dashboard = {
  students: { total: number; joiningLater: number; buildings: BuildingCard[] };
  rejoinRequests: { pending: number; oldestRequestedOn: string | null }; // India's date
  // Active means open or in progress, as for the complaint limits. Every student's count,
  // moved out or not: their complaints still need an answer. High priority is set by the
  // owner (day 7). oldestActiveAt is when the longest-waiting active complaint was raised.
  complaints: { active: number; highPriority: number; oldestActiveAt: Date | null };
};

// `today` is India's date ('YYYY-MM-DD'); the route passes hostelToday().
export async function getDashboard(db: Queryable, today: string): Promise<Dashboard> {
  // Every building, even an empty one, with its current students.
  const { rows: buildings } = await db.query<{ id: number; name: string; students: number; joiningLater: number }>(
    `SELECT b.id, b.name,
            count(u.id)::int AS students,
            count(u.id) FILTER (WHERE s.started_on > $1)::int AS "joiningLater"
     FROM buildings b
     LEFT JOIN stays s ON s.building_id = b.id AND s.ended_on IS NULL
     LEFT JOIN users u ON u.id = s.student_id AND u.is_active
     GROUP BY b.id
     ORDER BY lower(b.name), b.id`,
    [today],
  );

  // Beds per building, for the buildings that have any.
  const { rows: beds } = await db.query<{ buildingId: number; total: number; occupied: number }>(
    `SELECT r.building_id AS "buildingId",
            count(*)::int AS total,
            count(s.id)::int AS occupied
     FROM beds bd
     JOIN rooms r ON r.id = bd.room_id
     LEFT JOIN stays s ON s.bed_id = bd.id AND s.ended_on IS NULL
     WHERE bd.is_active
     GROUP BY r.building_id`,
  );
  const bedsOf = new Map(beds.map((b) => [b.buildingId, b]));

  const { rows: requests } = await db.query<{ pending: number; oldestRequestedOn: string | null }>(
    `SELECT count(*)::int AS pending,
            to_char(min(created_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS "oldestRequestedOn"
     FROM rejoin_requests WHERE status = 'pending'`,
  );

  const { rows: complaints } = await db.query<Dashboard["complaints"]>(
    `SELECT count(*)::int AS active,
            count(*) FILTER (WHERE priority = 'high')::int AS "highPriority",
            min(created_at) AS "oldestActiveAt"
     FROM complaints WHERE status IN ('open', 'in_progress')`,
  );

  const cards: BuildingCard[] = buildings.map((b) => {
    const bed = bedsOf.get(b.id);
    return {
      ...b,
      beds: bed ? { total: bed.total, occupied: bed.occupied, vacant: bed.total - bed.occupied } : null,
    };
  });

  return {
    students: {
      total: cards.reduce((sum, b) => sum + b.students, 0),
      joiningLater: cards.reduce((sum, b) => sum + b.joiningLater, 0),
      buildings: cards,
    },
    rejoinRequests: requests[0],
    complaints: complaints[0],
  };
}
