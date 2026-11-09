import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getStructure, type Building } from "../api/structure";
import { admitStudent, type Admission } from "../api/students";
import {
  checkAdmission,
  emptyAdmission,
  hostelToday,
  type AdmissionErrors,
  type AdmissionValues,
  type TextValues,
} from "./admissionForm";
import { WEEKDAYS } from "./format";
import { PlacePicker, withPlaceChange } from "./PlacePicker";
import { inputClass, primaryButton } from "./styles";
import { TemporaryPassword } from "./TemporaryPassword";
import { Skeleton } from "../ui";

// The owner's "Admit student" screen (design doc, section 9). Room and bed are offered
// only where the owner has built them. On success the temporary password is shown once,
// held only in this page's memory, and gone when the owner moves on.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function AdmitStudentPage() {
  const [buildings, setBuildings] = useState<Building[] | null>(null);
  const [values, setValues] = useState<AdmissionValues>(() => emptyAdmission(hostelToday()));
  const [errors, setErrors] = useState<AdmissionErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [admitted, setAdmitted] = useState<Admission | null>(null);

  const load = () =>
    getStructure()
      .then(setBuildings)
      .catch((err: unknown) => setServerError(errorText(err)));

  useEffect(() => {
    void load();
  }, []);

  // Changing a field clears its error. Changing the building forgets the room and bed;
  // changing the room forgets the bed, so a stale choice is never sent.
  const set = (name: keyof TextValues, value: string) => {
    setValues((v) => withPlaceChange(v, name, value));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };

  const toggleVegDay = (day: number) =>
    setValues((v) => ({
      ...v,
      vegDays: v.vegDays.includes(day) ? v.vegDays.filter((d) => d !== day) : [...v.vegDays, day],
    }));

  const setFlag = (name: "under18" | "guardianConsent", value: boolean) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => ({ ...e, guardianConsent: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const checked = checkAdmission(values, hostelToday());
    if ("errors" in checked) {
      setErrors(checked.errors);
      return;
    }
    setBusy(true);
    try {
      setAdmitted(await admitStudent(checked.form));
    } catch (err) {
      setServerError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const startAgain = () => {
    setAdmitted(null);
    setValues(emptyAdmission(hostelToday()));
    setErrors({});
    // The bed just taken now shows as occupied.
    void load();
  };

  if (admitted) {
    const building = buildings?.find((b) => b.id === admitted.student.buildingId);
    return <Admitted admission={admitted} buildingName={building?.name} onNext={startAgain} />;
  }

  const fieldProps = { values, errors, set };

  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Admit a student</h1>

      {serverError && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {serverError}
        </p>
      )}

      {buildings === null ? (
        !serverError && <Skeleton label="Loading buildings…" lines={4} />
      ) : buildings.length === 0 ? (
        <p className="text-sm text-muted">
          Every student lives in a building, so add a building first on{" "}
          <Link to="/structure" className="font-medium text-accent underline">
            Buildings and rooms
          </Link>
          .
        </p>
      ) : (
        <form noValidate onSubmit={submit} className="space-y-6">
          <Section title="Student">
            <TextField {...fieldProps} name="name" label="Full name" autoComplete="off" />
            <TextField {...fieldProps} name="email" label="Email" type="email" autoComplete="off" />
            <TextField {...fieldProps} name="phone" label="Mobile number" type="tel" inputMode="tel" />
            <TextField
              {...fieldProps}
              name="parentPhone"
              label="Parent or guardian mobile"
              type="tel"
              inputMode="tel"
            />
            <AgeField {...fieldProps} setFlag={setFlag} />
          </Section>

          <Section title="College or work">
            <SelectField {...fieldProps} name="category" label="Category">
              <option value="">Choose…</option>
              <option value="college">College student</option>
              <option value="working">Working professional</option>
              <option value="other">Other</option>
            </SelectField>
            {values.category === "college" && (
              <>
                <TextField {...fieldProps} name="collegeName" label="College" />
                <TextField {...fieldProps} name="branch" label="Branch" />
                <SelectField {...fieldProps} name="academicYear" label="Year">
                  <option value="">Choose…</option>
                  {[1, 2, 3, 4, 5, 6].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </SelectField>
              </>
            )}
            {values.category === "working" && (
              <>
                <TextField {...fieldProps} name="company" label="Company" />
                <TextField {...fieldProps} name="designation" label="Designation (optional)" />
              </>
            )}
          </Section>

          <Section title="Stay and fees">
            <TextField {...fieldProps} name="joiningDate" label="Joining date" type="date" />
            <FoodField {...fieldProps} toggleVegDay={toggleVegDay} />
            <TextField
              {...fieldProps}
              name="monthlyFee"
              label="Monthly fee in ₹ (optional)"
              inputMode="numeric"
            />
            <PlacePicker buildings={buildings} values={values} errors={errors} onChange={set} />
          </Section>

          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Admitting…" : "Admit student"}
          </button>
        </form>
      )}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-card border border-line bg-surface p-4 shadow-card">
      <legend className="float-left mb-4 w-full text-base font-bold text-ink">{title}</legend>
      <div className="grid clear-both gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

type FieldProps = {
  values: AdmissionValues;
  errors: AdmissionErrors;
  set: (name: keyof TextValues, value: string) => void;
};

// The label, the error under the field, and the links between them that screen readers
// (and the tests) follow.
function useFieldIds(errors: AdmissionErrors, name: keyof AdmissionValues) {
  const id = useId();
  const error = errors[name];
  return {
    id,
    error,
    errorId: `${id}-error`,
    aria: { "aria-invalid": error ? true : undefined, "aria-describedby": error ? `${id}-error` : undefined },
  };
}

function FieldError({ id, error }: { id: string; error?: string }) {
  return error ? (
    <p id={id} className="mt-1 text-sm text-danger">
      {error}
    </p>
  ) : null;
}

export function TextField({
  values,
  errors,
  set,
  name,
  label,
  type = "text",
  inputMode,
  autoComplete,
}: FieldProps & {
  name: keyof TextValues;
  label: string;
  type?: "text" | "email" | "tel" | "date";
  inputMode?: "tel" | "numeric";
  autoComplete?: string;
}) {
  const { id, error, errorId, aria } = useFieldIds(errors, name);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-muted">
        {label}
      </label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        value={values[name]}
        onChange={(e) => set(name, e.target.value)}
        className={inputClass}
        {...aria}
      />
      <FieldError id={errorId} error={error} />
    </div>
  );
}

export function SelectField({
  values,
  errors,
  set,
  name,
  label,
  children,
}: FieldProps & { name: keyof TextValues; label: string; children: ReactNode }) {
  const { id, error, errorId, aria } = useFieldIds(errors, name);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-muted">
        {label}
      </label>
      <select
        id={id}
        value={values[name]}
        onChange={(e) => set(name, e.target.value)}
        className={inputClass}
        {...aria}
      >
        {children}
      </select>
      <FieldError id={errorId} error={error} />
    </div>
  );
}

export function FoodField({
  values,
  errors,
  set,
  toggleVegDay,
}: FieldProps & { toggleVegDay: (day: number) => void }) {
  const { id, error, errorId } = useFieldIds(errors, "foodPreference");
  return (
    <div className="sm:col-span-2">
      <fieldset aria-describedby={error ? errorId : undefined}>
        <legend className="mb-1 block text-sm font-medium text-muted">Food preference</legend>
        <div className="flex gap-6 py-2">
          {(
            [
              ["veg", "Veg"],
              ["non_veg", "Non-Veg"],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex min-h-11 items-center gap-2 text-base text-ink">
              <input
                type="radio"
                name={`${id}-food`}
                value={value}
                checked={values.foodPreference === value}
                onChange={() => set("foodPreference", value)}
                className="size-4 accent-indigo-600"
              />
              {text}
            </label>
          ))}
        </div>
        <FieldError id={errorId} error={error} />
      </fieldset>
      {/* Some non-veg students avoid non-veg on particular weekdays (migration 006). */}
      {values.foodPreference === "non_veg" && (
        <fieldset className="mt-2">
          <legend className="mb-1 block text-sm font-medium text-muted">
            Eats veg on (optional)
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
            {WEEKDAYS.map((name, i) => (
              <label key={name} className="flex min-h-11 items-center gap-1.5 text-base text-ink">
                <input
                  type="checkbox"
                  checked={values.vegDays.includes(i + 1)}
                  onChange={() => toggleVegDay(i + 1)}
                  className="size-4 accent-indigo-600"
                />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

// Phase 5b: a student under 18, added only with a parent's or guardian's consent, which
// the owner confirms here (the Terms ask for it; the app records who and when).
export function AgeField({
  values,
  errors,
  setFlag,
  consentOn,
}: Omit<FieldProps, "set"> & {
  setFlag: (name: "under18" | "guardianConsent", value: boolean) => void;
  // When a consent is already recorded (editing), it is shown instead of asked for again.
  consentOn?: string;
}) {
  const { error, errorId, aria } = useFieldIds(errors, "guardianConsent");
  return (
    <div className="space-y-1 sm:col-span-2">
      <label className="flex min-h-11 items-center gap-2 text-base text-ink">
        <input
          type="checkbox"
          checked={values.under18}
          onChange={(e) => setFlag("under18", e.target.checked)}
          className="size-4 accent-indigo-600"
        />
        Under 18
      </label>
      {values.under18 &&
        (consentOn ? (
          <p className="text-sm text-muted">Guardian's consent confirmed on {consentOn}.</p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={values.guardianConsent}
                onChange={(e) => setFlag("guardianConsent", e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-indigo-600"
                {...aria}
              />
              I have their parent's or guardian's consent to add them to HostelConnect.
            </label>
            <FieldError id={errorId} error={error} />
          </>
        ))}
    </div>
  );
}

function Admitted({
  admission,
  buildingName,
  onNext,
}: {
  admission: Admission;
  buildingName?: string;
  onNext: () => void;
}) {
  return (
    <section className="space-y-4 rounded-card border border-emerald-400/40 bg-surface p-4 shadow-card">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Student admitted</h1>
      <p className="text-muted">
        <strong>{admission.student.name}</strong> ({admission.student.email}) can now log in
        {buildingName ? ` and lives in ${buildingName}` : ""}.
      </p>
      <TemporaryPassword password={admission.temporaryPassword} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onNext} className={primaryButton}>
          Admit another student
        </button>
        <Link
          to={`/students/${admission.student.id}`}
          className="text-sm font-medium text-accent hover:underline"
        >
          View profile
        </Link>
      </div>
    </section>
  );
}
