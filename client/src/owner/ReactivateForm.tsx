import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { getStructure, type Building } from "../api/structure";
import { reactivateStudent, type Admission, type ReactivationForm } from "../api/students";
import { addDays, hostelToday, MAX_DAYS_AHEAD } from "./admissionForm";
import { formatDate } from "./format";
import { bedStillFree, PlacePicker, withPlaceChange, type PlaceErrors, type PlaceValues } from "./PlacePicker";
import { inputClass, primaryButton, secondaryButton } from "./styles";
import { Skeleton } from "../ui";

// Bringing a former student back (design doc, sections 6 and 9), opened from the
// profile: a new joining date and a place. The server makes the new stay and the new
// temporary password; the profile shows the password once.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

type Values = PlaceValues & { joiningDate: string };
type Errors = PlaceErrors & { joiningDate?: string };

// The same rules the server applies, for fast feedback; the server checks them again.
function check(v: Values, leftOn: string | null, today: string): Errors {
  const errors: Errors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.joiningDate)) errors.joiningDate = "Choose a joining date.";
  else if (leftOn && v.joiningDate < leftOn)
    errors.joiningDate = `Choose ${formatDate(leftOn)} or later, the day they left.`;
  else if (v.joiningDate > addDays(today, MAX_DAYS_AHEAD))
    errors.joiningDate = `Choose a date at most ${MAX_DAYS_AHEAD} days from today.`;
  if (!v.buildingId) errors.buildingId = "Choose a building.";
  return errors;
}

export function ReactivateForm({
  studentId,
  leftOn,
  onDone,
  onCancel,
  send = (form) => reactivateStudent(studentId, form),
  title = "Reactivate",
  submitLabel = "Reactivate student",
}: {
  studentId: number;
  leftOn: string | null; // the day the student moved out ('YYYY-MM-DD')
  onDone: (result: Admission) => void;
  onCancel: () => void;
  // How the form is sent: a reactivation from the profile by default, or the approval
  // of a rejoin request (which reactivates the same way and also closes the request).
  send?: (form: ReactivationForm) => Promise<Admission>;
  title?: string;
  submitLabel?: string;
}) {
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [values, setValues] = useState<Values>(() => ({
    joiningDate: hostelToday(),
    buildingId: "",
    roomId: "",
    bedId: "",
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dateId = useId();
  // Unique per form: the requests page can show several cards, one form open at a time.
  const headingId = useId();

  useEffect(() => {
    let live = true;
    getStructure()
      .then((b) => live && setBuildings(b))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, []);

  // Changing a field clears its error; a new building or room forgets the choices below it.
  const set = (name: keyof Values, value: string) => {
    setValues((v) => withPlaceChange(v, name, value));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const found = check(values, leftOn, hostelToday());
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setBusy(true);
    try {
      onDone(
        await send({
          joiningDate: values.joiningDate,
          buildingId: Number(values.buildingId),
          roomId: values.roomId ? Number(values.roomId) : null,
          bedId: values.bedId ? Number(values.bedId) : null,
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      // As on the transfer form: show the beds as they are now and let go of a bed that
      // has just been taken.
      getStructure()
        .then((fresh) => {
          setBuildings(fresh);
          setValues((v) => (bedStillFree(fresh, v.bedId) ? v : { ...v, bedId: "" }));
        })
        .catch(() => {
          // The refusal message is already shown; the old list stays.
        });
    }
  };

  const cancel = (
    <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
      Cancel
    </button>
  );

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-card border border-indigo-400/40 bg-surface p-4 shadow-card"
    >
      <h2 id={headingId} className="text-base font-bold text-ink">
        {title}
      </h2>
      <p className="text-sm text-muted">
        {leftOn
          ? `Left on ${formatDate(leftOn)}. The new joining date can be that day or later, up to ${MAX_DAYS_AHEAD} days from today.`
          : `The joining date can be up to ${MAX_DAYS_AHEAD} days from today.`}
      </p>

      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}

      {buildings === null ? (
        <div className="space-y-4">
          {!error && <Skeleton label="Loading rooms…" lines={3} />}
          {cancel}
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={dateId} className="mb-1 block text-sm font-medium text-muted">
                Joining date
              </label>
              <input
                id={dateId}
                type="date"
                value={values.joiningDate}
                onChange={(e) => set("joiningDate", e.target.value)}
                className={inputClass}
                aria-invalid={errors.joiningDate ? true : undefined}
                aria-describedby={errors.joiningDate ? `${dateId}-error` : undefined}
              />
              {errors.joiningDate && (
                <p id={`${dateId}-error`} className="mt-1 text-sm text-danger">
                  {errors.joiningDate}
                </p>
              )}
            </div>
            <PlacePicker buildings={buildings} values={values} errors={errors} onChange={set} />
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy ? "Saving…" : submitLabel}
            </button>
            {cancel}
          </div>
        </form>
      )}
    </section>
  );
}
