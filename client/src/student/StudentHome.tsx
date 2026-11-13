import { SignOutOtherDevices } from "../components/SignOutOtherDevices";
import { MyComplaintsPage } from "./MyComplaintsPage";
import { MyFeesCard } from "./MyFeesPage";
import { ImportantNotices } from "./NoticesPage";
import { ReturnPollTile } from "./ReturnPollTile";

// The student's home (design doc, section 9): a greeting, then urgent and pinned notices,
// the open return poll, their complaints and, at the end, the fees summary. From lg up the
// fees sit in a column on the right, beside the complaints.

// "Good morning" in India's time, whatever the device's zone.
export function greeting(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(now),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const todayText = () =>
  new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );

export function StudentHome({ name }: { name: string }) {
  const firstName = name.trim().split(/\s+/)[0] ?? name;
  return (
    <div className="space-y-6">
      <div className="rise">
        <p className="text-sm font-semibold text-muted">{todayText()}</p>
        <p className="text-title font-display text-3xl font-extrabold tracking-tight md:text-4xl">
          {greeting()}, {firstName}
        </p>
      </div>
      <ImportantNotices />
      <ReturnPollTile />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0">
          <MyComplaintsPage />
        </div>
        <div className="lg:sticky lg:top-24">
          <MyFeesCard />
        </div>
      </div>
      <SignOutOtherDevices className="max-w-2xl" />
    </div>
  );
}
