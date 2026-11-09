import type { AdmissionForm, Category, FoodPreference, StudentEditForm } from "../api/students";

// The admission form's checks, the same rules as server/src/routes/students.ts, so the
// owner sees a mistake at once instead of after a round trip. The server still checks
// everything; this only gives faster feedback.

// What the inputs hold: text as typed, except the checkboxes.
export type AdmissionValues = TextValues & { vegDays: number[]; under18: boolean; guardianConsent: boolean };
export type TextValues = {
  name: string;
  email: string;
  phone: string;
  parentPhone: string;
  category: Category | "";
  collegeName: string;
  branch: string;
  academicYear: string;
  company: string;
  designation: string;
  joiningDate: string;
  foodPreference: FoodPreference | "";
  monthlyFee: string;
  buildingId: string;
  roomId: string;
  bedId: string;
};

export type AdmissionErrors = Partial<Record<keyof AdmissionValues, string>>;

export const emptyAdmission = (today: string): AdmissionValues => ({
  name: "",
  email: "",
  phone: "",
  parentPhone: "",
  category: "",
  collegeName: "",
  branch: "",
  academicYear: "",
  company: "",
  designation: "",
  joiningDate: today,
  foodPreference: "",
  vegDays: [],
  under18: false,
  guardianConsent: false,
  monthlyFee: "",
  buildingId: "",
  roomId: "",
  bedId: "",
});

export const MAX_DAYS_AHEAD = 30;

// Today in India, as YYYY-MM-DD, whatever zone the owner's phone is set to.
export function hostelToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// A 10-digit Indian mobile number, with an optional +91 and spaces or dashes.
// Returns the 10 digits, or null if it is not one.
export function cleanMobile(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  return /^(\+91)?[6-9]\d{9}$/.test(s) ? s.slice(-10) : null;
}

// A real calendar day written as YYYY-MM-DD (2026-02-30 is not one).
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Checks the form. Returns either the errors to show next to each field, or the body
// to send, with only the fields of the chosen category.
export function checkAdmission(
  v: AdmissionValues,
  today: string,
): { errors: AdmissionErrors } | { form: AdmissionForm } {
  const errors: AdmissionErrors = {};
  const required = "Required.";

  const name = v.name.trim();
  if (!name) errors.name = required;
  else if (name.length > 100) errors.name = "At most 100 characters.";

  const email = v.email.trim().toLowerCase();
  if (!email) errors.email = required;
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    errors.email = "Enter a valid email address.";
  }

  const mobileError = "Enter a 10-digit mobile number.";
  const phone = cleanMobile(v.phone);
  if (!v.phone.trim()) errors.phone = required;
  else if (!phone) errors.phone = mobileError;
  const parentPhone = cleanMobile(v.parentPhone);
  if (!v.parentPhone.trim()) errors.parentPhone = required;
  else if (!parentPhone) errors.parentPhone = mobileError;

  if (!v.category) errors.category = "Choose a category.";
  const text = (s: string) => s.trim();
  if (v.category === "college") {
    if (!text(v.collegeName)) errors.collegeName = required;
    if (!text(v.branch)) errors.branch = required;
    if (!v.academicYear) errors.academicYear = required;
  }
  if (v.category === "working" && !text(v.company)) errors.company = required;

  if (!v.joiningDate) errors.joiningDate = required;
  else if (!isRealDate(v.joiningDate)) errors.joiningDate = "Enter a valid date.";
  else if (v.joiningDate > addDays(today, MAX_DAYS_AHEAD)) {
    errors.joiningDate = `At most ${MAX_DAYS_AHEAD} days from today.`;
  }

  if (!v.foodPreference) errors.foodPreference = "Choose Veg or Non-Veg.";

  let monthlyFee: number | null = null;
  if (v.monthlyFee.trim()) {
    monthlyFee = Number(v.monthlyFee);
    if (!Number.isInteger(monthlyFee) || monthlyFee < 0 || monthlyFee > 1_000_000) {
      errors.monthlyFee = "Whole rupees, 0 to 10,00,000.";
    }
  }

  if (!v.buildingId) errors.buildingId = "Choose a building.";

  // Phase 5b: a student under 18 needs a parent's or guardian's consent first.
  if (v.under18 && !v.guardianConsent) errors.guardianConsent = "Confirm you have a parent's or guardian's consent.";

  if (Object.keys(errors).length > 0) return { errors };

  const category = v.category as Category;
  return {
    form: {
      name,
      email,
      phone: phone!,
      parentPhone: parentPhone!,
      category,
      ...(category === "college" && {
        collegeName: text(v.collegeName),
        branch: text(v.branch),
        academicYear: Number(v.academicYear),
      }),
      ...(category === "working" && {
        company: text(v.company),
        ...(text(v.designation) && { designation: text(v.designation) }),
      }),
      joiningDate: v.joiningDate,
      foodPreference: v.foodPreference as FoodPreference,
      // Only a non-veg student has veg days; a form switched back to Veg sends none.
      ...(v.foodPreference === "non_veg" &&
        v.vegDays.length > 0 && { vegDays: [...v.vegDays].sort((a, b) => a - b) }),
      monthlyFee,
      ...(v.under18 && { under18: true as const, guardianConsent: true as const }),
      buildingId: Number(v.buildingId),
      roomId: v.roomId ? Number(v.roomId) : null,
      bedId: v.bedId ? Number(v.bedId) : null,
    },
  };
}

// Checks the edit form: the same rules as admission, without the joining date and the
// place, which the edit form does not have. Returns the errors, or the body to send.
export function checkEdit(v: AdmissionValues): { errors: AdmissionErrors } | { form: StudentEditForm } {
  const today = hostelToday();
  // Stand-ins for the two fields admission requires and editing leaves out; both are
  // removed again below, so they are never sent.
  const checked = checkAdmission({ ...v, joiningDate: today, buildingId: "0", roomId: "", bedId: "" }, today);
  if ("errors" in checked) return checked;
  const { joiningDate: _date, buildingId: _building, roomId: _room, bedId: _bed, ...form } = checked.form;
  return { form };
}
