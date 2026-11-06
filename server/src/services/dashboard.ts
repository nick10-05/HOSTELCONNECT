import type { Queryable } from "../db";
import { FEE_ROW_DAYS_AHEAD } from "../jobs/feeRows";
import type { FeeTotal } from "./fees";
import { getPollCounts, type PollCounts, type ReturnPoll } from "./returnPolls";

// The owner's dashboard (design doc, section 9): every card in one answer, so the home
// page is one request even on a server that has just woken up. Day 5 adds the students
// and rejoin requests cards, day 6 the complaints card, day 9 the return poll and fees
// cards; later days add theirs as new keys.
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
  // Day 9: the open return poll with its counts, or null while none is open.
  returnPoll: (Pick<ReturnPoll, "id" | "title" | "createdAt"> & { counts: PollCounts }) | null;
  // Day 9: pending fees on `today` (India's date), every student's, moved out or not.
  fees: { dueSoon: FeeTotal; overdue: FeeTotal; pendingThisMonth: FeeTotal };
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

  // At most one poll is open (return_polls_one_open); the newest, should that rule change.
  // Its counts come from getPollCounts, the same rule as its results page.
  const { rows: polls } = await db.query<{ id: number; title: string; createdAt: Date }>(
    `SELECT id, title, created_at AS "createdAt" FROM return_polls
     WHERE status = 'open' ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const poll = polls[0] ?? null;

  // Pending fees only, whoever owes them. Due soon: from today to FEE_ROW_DAYS_AHEAD days
  // ahead, the rows the fee job has already created (today included, so a fee due today
  // shows somewhere). Overdue: due before today, in any month. This month: due in today's
  // calendar month, overdue or not. A fee with no amount counts but adds nothing.
  const { rows: feeRows } = await db.query<{
    soonCount: number;
    soonAmount: number;
    overdueCount: number;
    overdueAmount: number;
    monthCount: number;
    monthAmount: number;
  }>(
    `SELECT count(*) FILTER (WHERE soon)::int AS "soonCount",
            coalesce(sum(amount) FILTER (WHERE soon), 0)::bigint AS "soonAmount",
            count(*) FILTER (WHERE overdue)::int AS "overdueCount",
            coalesce(sum(amount) FILTER (WHERE overdue), 0)::bigint AS "overdueAmount",
            count(*) FILTER (WHERE this_month)::int AS "monthCount",
            coalesce(sum(amount) FILTER (WHERE this_month), 0)::bigint AS "monthAmount"
     FROM (
       SELECT amount,
              due_date BETWEEN $1::date AND $1::date + $2::int AS soon,
              due_date < $1::date AS overdue,
              date_trunc('month', due_date) = date_trunc('month', $1::date) AS this_month
       FROM fees WHERE status = 'pending'
     ) f`,
    [today, FEE_ROW_DAYS_AHEAD],
  );
  const f = feeRows[0];

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
    returnPoll: poll ? { ...poll, counts: (await getPollCounts(db, [poll.id])).get(poll.id)! } : null,
    fees: {
      dueSoon: { count: f.soonCount, amount: f.soonAmount },
      overdue: { count: f.overdueCount, amount: f.overdueAmount },
      pendingThisMonth: { count: f.monthCount, amount: f.monthAmount },
    },
  };
}
