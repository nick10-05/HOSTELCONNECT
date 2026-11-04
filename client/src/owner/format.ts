import type { Category, FoodPreference, Place } from "../api/students";

// Small display helpers shared by the owner's student screens.

// '2026-01-31' → '31 Jan 2026'. The day is a calendar date with no time, so it is read
// and printed in UTC, where it cannot shift by a day.
export function formatDate(day: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

// 6500 → '₹6,500' (Indian digit grouping: 1,00,000).
export const formatRupees = (amount: number) => `₹${amount.toLocaleString("en-IN")}`;

// '9876543210' → '98765 43210', easier to read aloud.
export const formatMobile = (digits: string) => `${digits.slice(0, 5)} ${digits.slice(5)}`;

// Weekday names in ISO order, 1 = Monday ... 7 = Sunday, as the server stores them.
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// 'Veg', 'Non-Veg', or 'Non-Veg (veg on Tue, Sat)'.
export function foodText(preference: FoodPreference, vegDays: number[]): string {
  if (preference === "veg") return "Veg";
  if (vegDays.length === 0) return "Non-Veg";
  return `Non-Veg (veg on ${vegDays.map((d) => WEEKDAYS[d - 1]).join(", ")})`;
}

export const categoryLabel: Record<Category, string> = {
  college: "College student",
  working: "Working professional",
  other: "Other",
};

// 'Block A · Floor 1 · Room 101 · Bed A'. The directory leaves the floor out to stay short.
export function placeText(place: Place, { withFloor = false } = {}): string {
  const parts = [place.buildingName];
  if (withFloor && place.floorNumber !== null) {
    parts.push(place.floorNumber === 0 ? "Ground floor" : `Floor ${place.floorNumber}`);
  }
  if (place.roomNumber !== null) parts.push(`Room ${place.roomNumber}`);
  if (place.bedNumber !== null) parts.push(`Bed ${place.bedNumber}`);
  if (place.roomNumber === null) parts.push("No room yet");
  return parts.join(" · ");
}
