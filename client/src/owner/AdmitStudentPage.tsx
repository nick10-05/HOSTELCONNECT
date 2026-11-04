import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getStructure, type Building, type Room } from "../api/structure";
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

// The owner's "Admit student" screen (design doc, section 9). Room and bed are offered
// only where the owner has built them. On success the temporary password is shown once,
// held only in this page's memory, and gone when the owner moves on.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const floorLabel = (number: number) => (number === 0 ? "Ground floor" : `Floor ${number}`);

const inputClass =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none aria-invalid:border-red-400";
const primaryButton =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButton =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";

// Every room of a building, with its floor, in the order the structure screen shows them.
type RoomChoice = { room: Room; label: string };
function roomsOf(building: Building | undefined): RoomChoice[] {
  if (!building) return [];
  return [
    ...building.floors.flatMap((f) =>
      f.rooms.map((room) => ({ room, label: `${room.roomNumber} · ${floorLabel(f.number)}` })),
    ),
    ...building.rooms.map((room) => ({ room, label: room.roomNumber })),
  ];
}

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
    setValues((v) => ({
      ...v,
      [name]: value,
      ...(name === "buildingId" && { roomId: "", bedId: "" }),
      ...(name === "roomId" && { bedId: "" }),
    }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };

  const toggleVegDay = (day: number) =>
    setValues((v) => ({
      ...v,
      vegDays: v.vegDays.includes(day) ? v.vegDays.filter((d) => d !== day) : [...v.vegDays, day],
    }));

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

  const building = buildings?.find((b) => String(b.id) === values.buildingId);
  const rooms = roomsOf(building);
  const room = rooms.find((r) => String(r.room.id) === values.roomId)?.room;
  const fieldProps = { values, errors, set };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Admit a student</h1>

      {serverError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {serverError}
        </p>
      )}

      {buildings === null ? (
        !serverError && <p className="text-sm text-slate-500">Loading…</p>
      ) : buildings.length === 0 ? (
        <p className="text-sm text-slate-700">
          Every student lives in a building, so add a building first on{" "}
          <Link to="/structure" className="font-medium text-indigo-700 underline">
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
            <SelectField {...fieldProps} name="buildingId" label="Building">
              <option value="">Choose…</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
            {rooms.length > 0 && (
              <SelectField {...fieldProps} name="roomId" label="Room (optional)">
                <option value="">No room yet</option>
                {rooms.map(({ room: r, label }) => (
                  <option key={r.id} value={r.id}>
                    {label}
                  </option>
                ))}
              </SelectField>
            )}
            {room && room.beds.length > 0 && (
              <SelectField {...fieldProps} name="bedId" label="Bed (optional)">
                <option value="">No bed yet</option>
                {room.beds.map((b) => {
                  const note = !b.isActive ? " (retired)" : b.occupied ? " (occupied)" : "";
                  return (
                    <option key={b.id} value={b.id} disabled={note !== ""}>
                      {b.bedNumber}
                      {note}
                    </option>
                  );
                })}
              </SelectField>
            )}
          </Section>

          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Admitting…" : "Admit student"}
          </button>
        </form>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <legend className="px-1 text-sm font-semibold text-slate-700">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
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
    <p id={id} className="mt-1 text-sm text-red-700">
      {error}
    </p>
  ) : null;
}

function TextField({
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
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
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

function SelectField({
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
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
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

function FoodField({
  values,
  errors,
  set,
  toggleVegDay,
}: FieldProps & { toggleVegDay: (day: number) => void }) {
  const { id, error, errorId } = useFieldIds(errors, "foodPreference");
  return (
    <div className="sm:col-span-2">
      <fieldset aria-describedby={error ? errorId : undefined}>
        <legend className="mb-1 block text-sm font-medium text-slate-700">Food preference</legend>
        <div className="flex gap-6 py-2">
          {(
            [
              ["veg", "Veg"],
              ["non_veg", "Non-Veg"],
            ] as const
          ).map(([value, text]) => (
            <label key={value} className="flex items-center gap-2 text-base text-slate-900">
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
          <legend className="mb-1 block text-sm font-medium text-slate-700">
            Eats veg on (optional)
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
            {WEEKDAYS.map((name, i) => (
              <label key={name} className="flex items-center gap-1.5 text-base text-slate-900">
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

function Admitted({
  admission,
  buildingName,
  onNext,
}: {
  admission: Admission;
  buildingName?: string;
  onNext: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(admission.temporaryPassword)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <section className="space-y-4 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">Student admitted</h1>
      <p className="text-slate-700">
        <strong>{admission.student.name}</strong> ({admission.student.email}) can now log in
        {buildingName ? ` and lives in ${buildingName}` : ""}.
      </p>
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">Temporary password</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-lg bg-slate-100 px-3 py-2 font-mono text-2xl tracking-widest text-slate-900">
            {admission.temporaryPassword}
          </code>
          <button type="button" onClick={copy} className={secondaryButton}>
            {copied ? "Copied" : "Copy password"}
          </button>
        </div>
      </div>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
        It is shown only now and cannot be seen again. Give it to the student in person; they
        must choose their own password when they first log in.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onNext} className={primaryButton}>
          Admit another student
        </button>
        <Link
          to={`/students/${admission.student.id}`}
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          View profile
        </Link>
      </div>
    </section>
  );
}
