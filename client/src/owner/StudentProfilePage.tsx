import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { getStudent, type Admission, type StudentProfile, type TransferredStay } from "../api/students";
import { hostelToday } from "./admissionForm";
import { categoryLabel, foodText, formatDate, formatMobile, formatRupees, placeText } from "./format";
import { MoveOutConfirm } from "./MoveOutConfirm";
import { ReactivateForm } from "./ReactivateForm";
import { ResetPasswordConfirm } from "./ResetPasswordConfirm";
import { primaryButton, secondaryButton } from "./styles";
import { TemporaryPassword } from "./TemporaryPassword";
import { TransferForm } from "./TransferForm";

// One student's profile for the owner (design doc, section 5), with the day 5 actions:
// transfer, move out and reset password for a current student, reactivate for a former one. Fee history
// arrives on day 9. Phone numbers appear only here, never in the directory or the page
// address.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

type Action = "transfer" | "moveOut" | "reactivate" | "resetPassword";

export function StudentProfilePage() {
  const { id } = useParams();
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The action form that is open, if any; only one at a time.
  const [action, setAction] = useState<Action | null>(null);
  // What the last action did, shown until the owner starts another.
  const [notice, setNotice] = useState<string | null>(null);
  // The profile could not be reloaded after a saved action; the page keeps the old one.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // After a reactivation: the temporary password, held only until the owner presses Done.
  const [reactivated, setReactivated] = useState<Admission | null>(null);
  // After a password reset: the temporary password, held only until the owner presses Done.
  const [resetPassword, setResetPassword] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setStudent(null);
    setError(null);
    getStudent(Number(id))
      .then((s) => current && setStudent(s))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [id]);

  // After a saved action: close the form and show the profile as it is now. The action
  // is saved whatever happens here, so a failed reload must not replace the page (and
  // the notice) with an error.
  const refresh = (what: string) => {
    setAction(null);
    getStudent(Number(id))
      .then(setStudent)
      .catch((err: unknown) =>
        setRefreshError(`The page could not be refreshed: ${errorText(err)} Reload the page to see ${what}.`),
      );
  };

  const open = (next: Action) => {
    setNotice(null);
    setRefreshError(null);
    setAction(next);
  };

  const transferred = (result: TransferredStay) => {
    setNotice(
      result.kind === "reassigned"
        ? `Room and bed changed. The stay still starts on ${formatDate(result.startedOn)}.`
        : "Transferred. The new stay starts today.",
    );
    refresh("the new stay");
  };

  const back = (
    <Link to="/students" className="text-sm font-medium text-indigo-700 hover:underline">
      ← All students
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      </div>
    );
  }
  if (!student) return <p className="text-sm text-slate-500">Loading…</p>;

  const s = student;
  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-slate-900">{s.name}</h1>
        {!s.isActive && <Badge tone="slate">Former student</Badge>}
        {s.isActive && s.mustChangePassword && <Badge tone="amber">Must change password</Badge>}
      </div>

      <Card title="Contact">
        <Item label="Email">{s.email}</Item>
        <Item label="Mobile">{formatMobile(s.phone)}</Item>
        <Item label="Parent or guardian">{formatMobile(s.parentPhone)}</Item>
      </Card>

      <Card title={categoryLabel[s.category]}>
        {s.category === "college" && (
          <>
            <Item label="College">{s.collegeName}</Item>
            <Item label="Branch">{s.branch}</Item>
            <Item label="Year">{s.academicYear}</Item>
          </>
        )}
        {s.category === "working" && (
          <>
            <Item label="Company">{s.company}</Item>
            <Item label="Designation">{s.designation ?? "—"}</Item>
          </>
        )}
        {s.category === "other" && <Item label="Category">Other</Item>}
      </Card>

      <Card title="Stay and fees">
        <Item label="Lives in">
          {s.currentStay
            ? placeText(s.currentStay, { withFloor: true })
            : s.deactivatedAt
              ? `Left on ${formatDate(s.deactivatedAt)}`
              : "No current stay"}
        </Item>
        <Item label="Joined">{formatDate(s.joiningDate)}</Item>
        <Item label="Food">{foodText(s.foodPreference, s.vegDays)}</Item>
        <Item label="Monthly fee">{s.monthlyFee === null ? "Not set" : formatRupees(s.monthlyFee)}</Item>
        {s.nextDueDate && <Item label="Next due date">{formatDate(s.nextDueDate)}</Item>}
      </Card>

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {refreshError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {refreshError}
        </p>
      )}

      {reactivated ? (
        <section
          aria-labelledby="reactivated-heading"
          className="space-y-4 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm"
        >
          <h2 id="reactivated-heading" className="text-sm font-semibold text-slate-700">
            Student reactivated
          </h2>
          <p className="text-slate-700">
            <strong>{reactivated.student.name}</strong> can log in again now; the new stay
            starts on {formatDate(reactivated.student.joiningDate)}.
          </p>
          <TemporaryPassword password={reactivated.temporaryPassword} />
          {/* Done forgets the password: it is never shown again. */}
          <button type="button" onClick={() => setReactivated(null)} className={primaryButton}>
            Done
          </button>
        </section>
      ) : resetPassword ? (
        <section
          aria-labelledby="password-reset-heading"
          className="space-y-4 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm"
        >
          <h2 id="password-reset-heading" className="text-sm font-semibold text-slate-700">
            Password reset
          </h2>
          <p className="text-slate-700">
            <strong>{s.name}</strong>&apos;s old password no longer works.
          </p>
          <TemporaryPassword password={resetPassword} />
          {/* Done forgets the password: it is never shown again. */}
          <button type="button" onClick={() => setResetPassword(null)} className={primaryButton}>
            Done
          </button>
        </section>
      ) : action === "resetPassword" ? (
        <ResetPasswordConfirm
          studentId={s.id}
          name={s.name}
          onDone={(temporaryPassword) => {
            setResetPassword(temporaryPassword);
            refresh("the change");
          }}
          onCancel={() => setAction(null)}
        />
      ) : action === "transfer" && s.currentStay ? (
        <TransferForm studentId={s.id} stay={s.currentStay} onDone={transferred} onCancel={() => setAction(null)} />
      ) : action === "moveOut" ? (
        <MoveOutConfirm
          studentId={s.id}
          name={s.name}
          stay={s.currentStay}
          onDone={() => {
            setNotice(`Moved out. ${s.name} can no longer log in.`);
            refresh("the change");
          }}
          onCancel={() => setAction(null)}
        />
      ) : action === "reactivate" ? (
        <ReactivateForm
          studentId={s.id}
          leftOn={s.deactivatedAt}
          onDone={(result) => {
            setReactivated(result);
            refresh("the change");
          }}
          onCancel={() => setAction(null)}
        />
      ) : (
        <div className="flex flex-wrap gap-3">
          {s.isActive && s.currentStay && (
            <button type="button" onClick={() => open("transfer")} className={secondaryButton}>
              {/* A stay that has not started is only reassigned (decided on day 5). */}
              {s.currentStay.startedOn > hostelToday() ? "Change room or bed" : "Transfer"}
            </button>
          )}
          {s.isActive && (
            <button type="button" onClick={() => open("resetPassword")} className={secondaryButton}>
              Reset password
            </button>
          )}
          {s.isActive ? (
            <button type="button" onClick={() => open("moveOut")} className={secondaryButton}>
              Move out
            </button>
          ) : (
            <button type="button" onClick={() => open("reactivate")} className={secondaryButton}>
              Reactivate
            </button>
          )}
        </div>
      )}

      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="stay-history" className="text-sm font-semibold text-slate-700">
          Stay history
        </h2>
        <ul aria-labelledby="stay-history" className="divide-y divide-slate-100">
          {s.stays.map((stay) => (
            <li key={stay.id} className="flex flex-col py-2 sm:flex-row sm:justify-between sm:gap-4">
              <span className="text-slate-900">{placeText(stay, { withFloor: true })}</span>
              <span className="text-sm text-slate-500">
                {formatDate(stay.startedOn)} – {stay.endedOn ? formatDate(stay.endedOn) : "now"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="text-slate-900">{children}</dd>
    </div>
  );
}

function Badge({ tone, children }: { tone: "slate" | "amber"; children: ReactNode }) {
  const colours = tone === "amber" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colours}`}>{children}</span>;
}
