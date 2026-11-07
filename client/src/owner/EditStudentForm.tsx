import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { updateStudent, type StudentProfile } from "../api/students";
import { checkEdit, type AdmissionErrors, type AdmissionValues, type TextValues } from "./admissionForm";
import { FoodField, Section, SelectField, TextField } from "./AdmitStudentPage";
import { formatDate, formatRupees } from "./format";
import { primaryButton, secondaryButton } from "./styles";

// Correcting a student's details on the profile (design doc, section 5): the admission
// form's fields and checks, filled in with what is stored. The joining date cannot change
// (the database will not move a stay's start), a move is a transfer, and a former
// student's fee stays as it is.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

// The stored details as the form's inputs hold them.
function valuesFrom(s: StudentProfile): AdmissionValues {
  return {
    name: s.name,
    email: s.email,
    phone: s.phone,
    parentPhone: s.parentPhone,
    category: s.category,
    collegeName: s.collegeName ?? "",
    branch: s.branch ?? "",
    academicYear: s.academicYear === null ? "" : String(s.academicYear),
    company: s.company ?? "",
    designation: s.designation ?? "",
    joiningDate: s.joiningDate,
    foodPreference: s.foodPreference,
    vegDays: [...s.vegDays],
    monthlyFee: s.monthlyFee === null ? "" : String(s.monthlyFee),
    buildingId: "",
    roomId: "",
    bedId: "",
  };
}

export function EditStudentForm({
  student,
  onDone,
  onCancel,
}: {
  student: StudentProfile;
  onDone: (updated: StudentProfile) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<AdmissionValues>(() => valuesFrom(student));
  const [errors, setErrors] = useState<AdmissionErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: keyof TextValues, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
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
    const checked = checkEdit(values);
    if ("errors" in checked) {
      setErrors(checked.errors);
      return;
    }
    setBusy(true);
    try {
      onDone(await updateStudent(student.id, checked.form));
    } catch (err) {
      setServerError(errorText(err));
      setBusy(false);
    }
  };

  const fieldProps = { values, errors, set };

  return (
    <form noValidate onSubmit={submit} aria-label="Edit details" className="space-y-6">
      {serverError && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {serverError}
        </p>
      )}

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

      <Section title="Food and fees">
        <p className="text-sm text-muted sm:col-span-2">
          Joining date: {formatDate(student.joiningDate)} (cannot be changed)
        </p>
        <FoodField {...fieldProps} toggleVegDay={toggleVegDay} />
        {student.isActive ? (
          <TextField
            {...fieldProps}
            name="monthlyFee"
            label="Monthly fee in ₹ (optional)"
            inputMode="numeric"
          />
        ) : (
          <p className="text-sm text-muted">
            Monthly fee: {student.monthlyFee === null ? "Not set" : formatRupees(student.monthlyFee)} (cannot be
            changed after moving out)
          </p>
        )}
      </Section>

      {student.isActive && (
        <p className="text-sm text-muted">
          A new monthly fee applies from the next fee; fees already listed keep their amount.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Saving…" : "Save details"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
