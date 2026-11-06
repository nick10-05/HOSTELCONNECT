import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
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
import { categoryLabel } from "../components/complaintText";
import { compressPhoto, PhotoError } from "./compressPhoto";

// The complaint form (design doc, sections 2 and 9): a category, a short description and,
// since day 8, an optional photo. It checks the server's rules as the student types
// (trimmed, 10 to 500 characters) and offers categories that already have an active
// complaint as unavailable. The photo is shrunk in the browser as soon as it is chosen
// (compressPhoto), and offered only while the server allows uploads. The server checks
// everything again; its refusal, such as a limit reached since the page loaded, is shown
// word for word.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

type Photo =
  | { state: "none" }
  | { state: "preparing" }
  | { state: "ready"; blob: Blob }
  | { state: "failed"; message: string };

export function NewComplaintPage() {
  const navigate = useNavigate();
  const [canRaise, setCanRaise] = useState<RaiseStatus | null>(null);
  const [photoAllowed, setPhotoAllowed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [category, setCategory] = useState<ComplaintCategory | "">("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<Photo>({ state: "none" });
  // Changing the key empties the file field, so the same photo can be chosen again.
  const [photoInputKey, setPhotoInputKey] = useState(0);
  // Only the latest choice may set the photo, if the student picks again while one is
  // still being prepared.
  const latestChoice = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Only the first page's answer is needed here: whether a complaint is possible now,
  // which categories are taken, and whether a photo may be added.
  useEffect(() => {
    let current = true;
    listMyComplaints()
      .then((r) => {
        if (!current) return;
        setCanRaise(r.canRaise);
        setPhotoAllowed(r.photoUploadsAllowed);
      })
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);

  const length = descriptionLength(description);
  const tooShort = length < DESCRIPTION_MIN;
  const tooLong = length > DESCRIPTION_MAX;
  const taken = new Set(canRaise?.activeCategories ?? []);
  const preparing = photo.state === "preparing";

  const choosePhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const choice = ++latestChoice.current;
    setPhoto({ state: "preparing" });
    try {
      const blob = await compressPhoto(file);
      if (choice === latestChoice.current) setPhoto({ state: "ready", blob });
    } catch (err) {
      if (choice !== latestChoice.current) return;
      setPhoto({
        state: "failed",
        message: err instanceof PhotoError ? err.message : "This photo could not be prepared. Try another photo.",
      });
      setPhotoInputKey((k) => k + 1);
    }
  };

  const removePhoto = () => {
    latestChoice.current += 1;
    setPhoto({ state: "none" });
    setPhotoInputKey((k) => k + 1);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (category === "" || tooShort || tooLong || preparing) return;
    setError(null);
    setSending(true);
    try {
      const created = await createComplaint({
        category,
        description: description.trim(),
        photo: photo.state === "ready" ? photo.blob : null,
      });
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

          {photoAllowed ? (
            <div>
              <label htmlFor="complaint-photo" className="block text-sm font-medium text-slate-700">
                Photo (optional)
              </label>
              <input
                key={photoInputKey}
                id="complaint-photo"
                type="file"
                // Any picture, so phones offer the camera; compressPhoto decides what it can read.
                accept="image/*"
                onChange={choosePhoto}
                aria-describedby="complaint-photo-status"
                className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
              />
              <div id="complaint-photo-status" className="mt-1 flex items-center gap-3 text-sm">
                {photo.state === "preparing" && <span className="text-slate-500">Preparing photo…</span>}
                {photo.state === "ready" && (
                  <>
                    <span className="text-slate-700">Photo ready ({Math.round(photo.blob.size / 1024)} KB)</span>
                    <button type="button" onClick={removePhoto} className="font-medium text-indigo-700 hover:underline">
                      Remove photo
                    </button>
                  </>
                )}
                {photo.state === "failed" && <span className="text-red-700">{photo.message}</span>}
                {photo.state === "none" && (
                  <span className="text-slate-500">Photos are kept for 48 hours, then deleted.</span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Photos are switched off for now. You can still send the complaint as text.</p>
          )}

          <button
            type="submit"
            disabled={sending || preparing || category === "" || tooShort || tooLong}
            className={`${primaryButton} w-full sm:w-auto`}
          >
            {sending ? "Sending…" : "Send complaint"}
          </button>
        </form>
      )}
    </div>
  );
}
