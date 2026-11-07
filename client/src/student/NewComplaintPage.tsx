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
import { Skeleton } from "../ui";
import { backLinkClass } from "../ui/ListParts";

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
        <Link to="/" className={backLinkClass}>
          ← My complaints
        </Link>
        <h1 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">New complaint</h1>
        <p className="mt-1 text-sm font-medium text-muted">Tell the hostel what needs fixing. The owner sees it straight away.</p>
      </div>

      {loadError ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {loadError}
        </p>
      ) : !canRaise ? (
        <Skeleton label="Loading…" lines={4} />
      ) : !canRaise.allowed ? (
        <p role="alert" className="hc-pill-amber rounded-2xl px-3.5 py-3 text-sm font-medium">
          {canRaise.reason}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="rise space-y-6 rounded-card border border-line bg-surface p-4 shadow-card sm:p-6">
          {error && (
            <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="complaint-category" className="block text-sm font-semibold text-ink">
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
              <p id="complaint-category-taken" className="mt-1 text-sm text-muted">
                You already have an active complaint in{" "}
                {[...taken].map((c) => categoryLabel[c]).join(", ")}. You can raise another one there when it
                is resolved or rejected.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="complaint-description" className="block text-sm font-semibold text-ink">
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
              className={`mt-1 flex justify-between gap-2 text-sm ${tooLong ? "font-semibold text-danger" : "text-muted"}`}
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
              <label htmlFor="complaint-photo" className="block text-sm font-semibold text-ink">
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
                className="mt-2 block w-full rounded-2xl border-2 border-dashed border-line bg-soft/50 p-3 text-sm text-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-xl file:border-0 file:bg-surface file:px-4 file:text-sm file:font-semibold file:text-ink file:shadow-card"
              />
              <div id="complaint-photo-status" className="mt-1 flex items-center gap-3 text-sm">
                {photo.state === "preparing" && <span className="text-muted">Preparing photo…</span>}
                {photo.state === "ready" && (
                  <>
                    <span className="font-medium text-success">Photo ready ({Math.round(photo.blob.size / 1024)} KB)</span>
                    <button type="button" onClick={removePhoto} className="min-h-11 font-semibold text-accent hover:underline">
                      Remove photo
                    </button>
                  </>
                )}
                {photo.state === "failed" && <span className="font-medium text-danger">{photo.message}</span>}
                {photo.state === "none" && (
                  <span className="text-muted">Photos are kept for 48 hours, then deleted.</span>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">Photos are switched off for now. You can still send the complaint as text.</p>
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
