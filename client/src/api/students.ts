import { apiFetch } from "./client";

// Students. Shapes match server/src/routes/students.ts and services/students.ts.

export type Category = "college" | "working" | "other";
export type FoodPreference = "veg" | "non_veg";

// What the admission form sends. The server checks and cleans it again.
export type AdmissionForm = {
  name: string;
  email: string;
  phone: string;
  parentPhone: string;
  category: Category;
  collegeName?: string;
  branch?: string;
  academicYear?: number;
  company?: string;
  designation?: string;
  joiningDate: string; // YYYY-MM-DD
  foodPreference: FoodPreference;
  // Weekdays a non-veg student eats veg: 1 = Monday ... 7 = Sunday.
  vegDays?: number[];
  monthlyFee: number | null;
  buildingId: number;
  roomId: number | null;
  bedId: number | null;
};

export type Admission = {
  student: {
    id: number;
    name: string;
    email: string;
    joiningDate: string;
    buildingId: number;
    roomId: number | null;
    bedId: number | null;
  };
  // Shown to the owner once; the server never sends it again.
  temporaryPassword: string;
};

// POST /api/students. Refusals arrive as ApiError: 409 "bed_occupied", "email_taken",
// "bed_retired"; 404 when the building, room or bed has gone; 400 "invalid_input".
export async function admitStudent(form: AdmissionForm): Promise<Admission> {
  return apiFetch<Admission>("/api/students", { method: "POST", body: form });
}

// ---- Directory and profile. Shapes match server/src/services/students.ts. ----

// Where a student lives now; room, floor and bed are null where not set.
export type Place = {
  buildingId: number;
  buildingName: string;
  floorNumber: number | null;
  roomId: number | null;
  roomNumber: string | null;
  bedId: number | null;
  bedNumber: string | null;
};

export type StudentListItem = {
  id: number;
  name: string;
  email: string;
  category: Category;
  joiningDate: string;
  isActive: boolean;
  place: Place | null;
};

export type Stay = Place & { id: number; startedOn: string; endedOn: string | null };

export type StudentProfile = {
  id: number;
  name: string;
  email: string;
  phone: string;
  parentPhone: string;
  category: Category;
  collegeName: string | null;
  branch: string | null;
  academicYear: number | null;
  company: string | null;
  designation: string | null;
  joiningDate: string;
  foodPreference: FoodPreference;
  vegDays: number[];
  monthlyFee: number | null;
  isActive: boolean;
  deactivatedAt: string | null;
  mustChangePassword: boolean;
  currentStay: Stay | null;
  stays: Stay[];
  nextDueDate: string | null;
};

// The directory's filters, exactly as they appear in the page address and the API's
// query string, so one can be copied into the other.
export type DirectoryQuery = {
  search?: string;
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  category?: string;
  status?: string; // "active" (default), "former" or "all"
  page?: string;
};

// GET /api/students: one page of the directory and the number of matches in all.
export async function listStudents(
  query: DirectoryQuery,
): Promise<{ items: StudentListItem[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const qs = params.toString();
  return apiFetch(`/api/students${qs ? `?${qs}` : ""}`);
}

// GET /api/students/:id: the full profile. 404 "student_not_found" if there is none.
export async function getStudent(id: number): Promise<StudentProfile> {
  const { student } = await apiFetch<{ student: StudentProfile }>(`/api/students/${id}`);
  return student;
}
