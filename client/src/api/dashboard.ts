import { apiFetch } from "./client";

// The owner's dashboard. Shapes match server/src/services/dashboard.ts.

export type BuildingCard = {
  id: number;
  name: string;
  students: number; // current students, including those not arrived yet
  joiningLater: number;
  beds: { total: number; occupied: number; vacant: number } | null; // null = no beds yet
};

export type Dashboard = {
  students: { total: number; joiningLater: number; buildings: BuildingCard[] };
  rejoinRequests: { pending: number; oldestRequestedOn: string | null }; // 'YYYY-MM-DD'
};

// GET /api/dashboard: every card in one answer.
export async function getDashboard(): Promise<Dashboard> {
  return apiFetch<Dashboard>("/api/dashboard");
}
