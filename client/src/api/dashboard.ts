import { apiFetch } from "./client";
import type { FeeTotal } from "./fees";
import type { PollCounts, ReturnPoll } from "./returnPolls";

// The owner's dashboard. Shapes match server/src/services/dashboard.ts.

export type BuildingCard = {
  id: number;
  name: string;
  students: number; // current students, including those not arrived yet
  joiningLater: number;
  beds: { total: number; occupied: number; vacant: number } | null; // null = no beds yet
};

// The storage and bandwidth card (day 8): server/src/services/usage.ts's Usage, plus
// photosConfigured (false when photo storage is not set up). Percentages are rounded down
// and can pass 100; egress.month is 'YYYY-MM' (India's calendar).
export type UsageCard = {
  storage: { usedBytes: number; limitBytes: number; percent: number };
  egress: { month: string; usedBytes: number; limitBytes: number; percent: number };
  level: "ok" | "amber" | "uploads_off";
  uploadsAllowed: boolean;
  failingDeletions: number;
  photosConfigured: boolean;
};

export type Dashboard = {
  students: { total: number; joiningLater: number; buildings: BuildingCard[] };
  rejoinRequests: { pending: number; oldestRequestedOn: string | null }; // 'YYYY-MM-DD'
  // Active = open or in progress; oldestActiveAt is an ISO timestamp.
  complaints: { active: number; highPriority: number; oldestActiveAt: string | null };
  usage: UsageCard;
  // Day 9: the open return poll with its counts, or null while none is open.
  returnPoll: (Pick<ReturnPoll, "id" | "title" | "createdAt"> & { counts: PollCounts }) | null;
  // Day 9: pending fees, every student's. Due soon: today to 7 days ahead; overdue: due
  // before today, any month; this month: due in today's month, overdue or not. A fee with
  // no amount set counts but adds nothing.
  fees: { dueSoon: FeeTotal; overdue: FeeTotal; pendingThisMonth: FeeTotal };
};

// GET /api/dashboard: every card in one answer.
export async function getDashboard(): Promise<Dashboard> {
  return apiFetch<Dashboard>("/api/dashboard");
}
