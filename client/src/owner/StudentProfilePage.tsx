import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { getStudent, type Admission, type StudentProfile, type TransferredStay } from "../api/students";
import { hostelToday } from "./admissionForm";
import { EditStudentForm } from "./EditStudentForm";
import { categoryLabel, foodText, formatDate, formatMobile, formatRupees, placeText } from "./format";
import { MoveOutConfirm } from "./MoveOutConfirm";
import { ReactivateForm } from "./ReactivateForm";
import { ResetPasswordConfirm } from "./ResetPasswordConfirm";
import { buttonClass, IconTile, Skeleton, type Tone } from "../ui";
import { BedIcon, BuildingIcon, ClockIcon, MessageIcon } from "../ui/icons";
import { Avatar, backLinkClass } from "../ui/ListParts";
import { primaryButton, secondaryButton } from "./styles";
import { TemporaryPassword } from "./TemporaryPassword";
import { TransferForm } from "./TransferForm";

// One student's profile for the owner (design doc, section 5), with the day 5 actions:
// transfer, move out and reset password for a current student, reactivate for a former one,
// and editing the details for both. Fee history
// arrives on day 9. Phone numbers appear only here, never in the directory or the page
// address.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

type Action = "transfer" | "moveOut" | "reactivate" | "resetPassword" | "edit";

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
    <Link to="/students" className={backLinkClass}>
      ← All students
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      </div>
    );
  }
  if (!student) return <Skeleton label="Loading the student…" lines={5} />;

  const s = student;
  return (
    <div className="space-y-6">
      {back}
      <div className="rise bg-hero relative flex items-center gap-4 overflow-hidden rounded-[1.75rem] p-5 shadow-[var(--hc-hero-shadow)] md:p-6">
        <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/15 blur-2xl" />
        <Avatar name={s.name} size="lg" />
        <div className="relative min-w-0 space-y-1.5">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-hero-ink md:text-3xl">{s.name}</h1>
          <p className="text-sm text-hero-muted">
            {s.currentStay ? placeText(s.currentStay, { withFloor: true }) : categoryLabel[s.category]}
          </p>
          {(!s.isActive || s.mustChangePassword) && (
            <p className="flex flex-wrap gap-2">
              {!s.isActive && <Badge tone="slate">Former student</Badge>}
              {s.isActive && s.mustChangePassword && <Badge tone="amber">Must change password</Badge>}
            </p>
          )}
        </div>
      </div>

      <Card title="Contact" tone="violet" Icon={MessageIcon}>
        <Item label="Email">{s.email}</Item>
        <Item label="Mobile">{formatMobile(s.phone)}</Item>
        <Item label="Parent or guardian">{formatMobile(s.parentPhone)}</Item>
        {s.under18 && (
          <Item label="Under 18">
            {s.guardianConsent
              ? `Guardian's consent confirmed by ${s.guardianConsent.by} on ${formatDate(s.guardianConsent.on)}`
              : "Guardian's consent not recorded"}
          </Item>
        )}
      </Card>

      <Card title={categoryLabel[s.category]} tone="blue" Icon={BuildingIcon}>
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

      <Card title="Stay and fees" tone="green" Icon={BedIcon}>
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
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {notice}
        </p>
      )}
      {refreshError && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {refreshError}
        </p>
      )}

      {reactivated ? (
        <section
          aria-labelledby="reactivated-heading"
          className="space-y-4 rounded-card border border-emerald-400/40 bg-surface p-4 shadow-card"
        >
          <h2 id="reactivated-heading" className="text-base font-bold text-ink">
            Student reactivated
          </h2>
          <p className="text-muted">
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
          className="space-y-4 rounded-card border border-emerald-400/40 bg-surface p-4 shadow-card"
        >
          <h2 id="password-reset-heading" className="text-base font-bold text-ink">
            Password reset
          </h2>
          <p className="text-muted">
            <strong>{s.name}</strong>&apos;s old password no longer works.
          </p>
          <TemporaryPassword password={resetPassword} />
          {/* Done forgets the password: it is never shown again. */}
          <button type="button" onClick={() => setResetPassword(null)} className={primaryButton}>
            Done
          </button>
        </section>
      ) : action === "edit" ? (
        <EditStudentForm
          student={s}
          onDone={(updated) => {
            // The answer is the profile as it is now, so no second load is needed.
            setStudent(updated);
            setAction(null);
            setNotice("Details saved.");
          }}
          onCancel={() => setAction(null)}
        />
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
          <button type="button" onClick={() => open("edit")} className={secondaryButton}>
            Edit details
          </button>
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
            <button type="button" onClick={() => open("moveOut")} className={buttonClass("danger")}>
              Move out
            </button>
          ) : (
            <button type="button" onClick={() => open("reactivate")} className={secondaryButton}>
              Reactivate
            </button>
          )}
        </div>
      )}

      <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-card md:p-5">
        <div className="flex items-center gap-3">
          <IconTile tone="orange" size="sm">
            <ClockIcon size={18} />
          </IconTile>
          <h2 id="stay-history" className="text-base font-bold text-ink">
            Stay history
          </h2>
        </div>
        <ul aria-labelledby="stay-history" className="divide-y divide-line">
          {s.stays.map((stay) => (
            <li key={stay.id} className="flex flex-col py-2 sm:flex-row sm:justify-between sm:gap-4">
              <span className="text-ink">{placeText(stay, { withFloor: true })}</span>
              <span className="text-sm text-muted">
                {formatDate(stay.startedOn)} – {stay.endedOn ? formatDate(stay.endedOn) : "now"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Card({
  title,
  tone,
  Icon,
  children,
}: {
  title: string;
  tone: Tone;
  Icon: typeof BedIcon;
  children: ReactNode;
}) {
  return (
    <section className="rise space-y-4 rounded-card border border-line bg-surface p-4 shadow-card md:p-5">
      <div className="flex items-center gap-3">
        <IconTile tone={tone} size="sm">
          <Icon size={18} />
        </IconTile>
        <h2 className="text-base font-bold text-ink">{title}</h2>
      </div>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 font-medium break-words text-ink">{children}</dd>
    </div>
  );
}

function Badge({ tone, children }: { tone: "slate" | "amber"; children: ReactNode }) {
  const colours = tone === "amber" ? "hc-pill-amber" : "hc-pill-grey";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${colours}`}>{children}</span>;
}
