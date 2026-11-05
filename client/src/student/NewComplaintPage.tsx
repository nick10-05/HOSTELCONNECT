import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import {
  COMPLAINT_CATEGORIES,
  createComplaint,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  descriptionLength,
  listMyComplaints,
  type ComplaintCategory,
  type RaiseStatus,
} from "../api/complaints";
import { inputClass, primaryButton } from "../owner/styles";
import { categoryLabel } from "./complaintText";

// The complaint form (design doc, sections 2 and 9): a category and a short description,
// text only until photos arrive on day 8. It checks the server's rules as the student
// types (trimmed, 10 to 500 characters) and offers categories that already have an active
// complaint as unavailable. The server checks everything again; its refusal, such as a
// limit reached since the page loaded, is shown word for word.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

export function NewComplaintPage() {
  const navigate = useNavigate();
  const [canRaise, setCanRaise] = useState<RaiseStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState<ComplaintCategory | "">("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Only the first page's answer is needed here: whether a complaint is possible now, and
  // which categories are taken.
  useEffect(() => {
    let current = true;
    listMyComplaints()
      .then((r) => current && setCanRaise(r.canRaise))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);

  const length = descriptionLength(description);
  const tooShort = length < DESCRIPTION_MIN;
  const tooLong = length > DESCRIPTION_MAX;
  const taken = new Set(canRaise?.activeCategories ?? []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (category === "" || tooShort || tooLong) return;
    setError(null);
    setSending(true);
    try {
      const created = await createComplaint({ category, description: description.trim() });
      navigate(`/complaints/${created.id}`, { state: { created: true } });
    } catch (err) {
      setError(errorText(err));
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link to="/" className="text-sm font-medium text-indigo-700 hover:underline">
          ← My complaints
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-slate-900">New complaint</h1>
      </div>

      {loadError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </p>
      ) : !canRaise ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : !canRaise.allowed ? (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {canRaise.reason}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="complaint-category" className="block text-sm font-medium text-slate-700">
              Category
            </label>
            <select
              id="complaint-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as ComplaintCategory | "")}
              aria-describedby={taken.size > 0 ? "complaint-category-taken" : undefined}
              className={`${inputClass} mt-1`}
            >
              <option value="">Choose a category</option>
              {COMPLAINT_CATEGORIES.map((c) => (
                <option key={c} value={c} disabled={taken.has(c)}>
                  {taken.has(c) ? `${categoryLabel[c]} (already active)` : categoryLabel[c]}
                </option>
              ))}
            </select>
            {taken.size > 0 && (
              <p id="complaint-category-taken" className="mt-1 text-sm text-slate-500">
                You already have an active complaint in{" "}
                {[...taken].map((c) => categoryLabel[c]).join(", ")}. You can raise another one there when it
                is resolved or rejected.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-description" className="block text-sm font-medium text-slate-700">
              What is wrong?
            </label>
            <textarea
              id="complaint-description"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-describedby="complaint-description-count"
              aria-invalid={tooLong ? true : undefined}
              className={`${inputClass} mt-1`}
            />
            <p
              id="complaint-description-count"
              className={`mt-1 flex justify-between gap-2 text-sm ${tooLong ? "text-red-700" : "text-slate-500"}`}
            >
              <span>
                {tooShort ? `At least ${DESCRIPTION_MIN} characters` : tooLong ? "Too long" : ""}
              </span>
              <span>
                {length} / {DESCRIPTION_MAX}
              </span>
            </p>
          </div>

          <button
            type="submit"
            disabled={sending || category === "" || tooShort || tooLong}
            className={`${primaryButton} w-full sm:w-auto`}
          >
            {sending ? "Sending…" : "Send complaint"}
          </button>
        </form>
      )}
    </div>
  );
}
