import { useEffect, useId, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import {
  BODY_MAX,
  deleteAnnouncement,
  listAnnouncements,
  postAnnouncement,
  textLength,
  TITLE_MAX,
  updateAnnouncement,
  type Announcement,
  type AnnouncementChanges,
} from "../api/announcements";
import { ApiError } from "../api/client";
import { NoticeCard } from "../components/NoticeCard";
import { inputClass, primaryButton, secondaryButton } from "./styles";
import { ListSkeleton, Pager } from "../ui/ListParts";

// The owner's notices (design doc, sections 2, 8 and 9): post one with an optional Urgent
// and Pin, then edit, pin or unpin, mark urgent or not, or delete it. Posting notifies
// every current student; nothing else does. Deleting asks first, because the notice also
// disappears from every student's notifications. The page number is in the address.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const smallButton =
  "press inline-flex min-h-10 items-center justify-center gap-1 rounded-xl border border-line bg-surface px-3 text-sm font-semibold text-ink shadow-card hover:bg-soft disabled:cursor-not-allowed disabled:opacity-50";

export function AnnouncementsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [result, setResult] = useState<{ items: Announcement[]; total: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // The result of the last action: a confirmation or the server's refusal.
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    setLoadError(null);
    listAnnouncements(page)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, [page, reloads]);

  // Runs one change, then reloads the list (the order may change: pinned first).
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      setMessage(done);
      setReloads((n) => n + 1);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Announcements</h1>

      <PostForm
        busy={busy}
        onPost={(notice) => run(() => postAnnouncement(notice), "Posted. Every current student has been notified.")}
      />

      {message && (
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}

      {loadError ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {loadError}
        </p>
      ) : !result ? (
        <ListSkeleton label="Loading notices…" rows={3} />
      ) : result.total === 0 ? (
        <p className="text-sm text-muted">No notices yet.</p>
      ) : (
        <>
          <ul aria-label="Notices" className="space-y-3">
            {result.items.map((n) => (
              <li key={n.id}>
                {editing === n.id ? (
                  <EditForm
                    notice={n}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={async (changes) => {
                      const ok = await run(
                        () => updateAnnouncement(n.id, changes),
                        "Saved. Students were not notified again.",
                      );
                      if (ok) setEditing(null);
                    }}
                  />
                ) : (
                  <NoticeCard notice={n}>
                    {confirmingDelete === n.id ? (
                      <div role="group" aria-label="Confirm delete" className="hc-pill-red space-y-2 rounded-2xl p-3">
                        <p className="text-sm text-danger">
                          Delete this notice? It also disappears from every student's notifications.
                        </p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            className="press inline-flex min-h-10 items-center justify-center rounded-xl bg-rose-600 px-3 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-60"
                            onClick={async () => {
                              const ok = await run(
                                () => deleteAnnouncement(n.id),
                                "Deleted. It is gone from every student's notifications.",
                              );
                              if (ok) setConfirmingDelete(null);
                            }}
                          >
                            Yes, delete
                          </button>
                          <button type="button" className={smallButton} onClick={() => setConfirmingDelete(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() =>
                            void run(
                              () => updateAnnouncement(n.id, { isPinned: !n.isPinned }),
                              n.isPinned ? "Unpinned." : "Pinned.",
                            )
                          }
                        >
                          {n.isPinned ? "Unpin" : "Pin"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() =>
                            void run(
                              () => updateAnnouncement(n.id, { isUrgent: !n.isUrgent }),
                              n.isUrgent ? "No longer urgent." : "Marked urgent.",
                            )
                          }
                        >
                          {n.isUrgent ? "Not urgent" : "Mark urgent"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() => {
                            setConfirmingDelete(null);
                            setEditing(n.id);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() => {
                            setEditing(null);
                            setConfirmingDelete(n.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </NoticeCard>
                )}
              </li>
            ))}
          </ul>
          <Pager page={page} pages={pages} onPage={(n) => setParams(n > 1 ? { page: String(n) } : {})} />
        </>
      )}
    </div>
  );
}

// A title or body field with a counter, counted as the server counts characters.
function TextField({
  label,
  value,
  max,
  multiline,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const length = textLength(value);
  const tooLong = length > max;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-muted">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          rows={4}
          value={value}
          aria-invalid={tooLong}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      ) : (
        <input
          id={id}
          value={value}
          aria-invalid={tooLong}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
      <p className={`text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
        {length} / {max}
      </p>
    </div>
  );
}

const fits = (text: string, max: number) => textLength(text) >= 1 && textLength(text) <= max;

function PostForm({
  busy,
  onPost,
}: {
  busy: boolean;
  onPost: (notice: { title: string; body: string; isUrgent: boolean; isPinned: boolean }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isUrgent, setUrgent] = useState(false);
  const [isPinned, setPinned] = useState(false);
  const canPost = !busy && fits(title, TITLE_MAX) && fits(body, BODY_MAX);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canPost) return;
    if (await onPost({ title: title.trim(), body: body.trim(), isUrgent, isPinned })) {
      setTitle("");
      setBody("");
      setUrgent(false);
      setPinned(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-labelledby="post-heading"
      className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card sm:p-6"
    >
      <h2 id="post-heading" className="text-base font-bold text-ink">
        Post a notice
      </h2>
      <TextField label="Title" value={title} max={TITLE_MAX} onChange={setTitle} />
      <TextField label="Notice" value={body} max={BODY_MAX} multiline onChange={setBody} />
      <div className="flex flex-wrap gap-4">
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink">
          <input type="checkbox" className="size-4 accent-violet-700" checked={isUrgent} onChange={(e) => setUrgent(e.target.checked)} />
          Urgent
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink">
          <input type="checkbox" className="size-4 accent-violet-700" checked={isPinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin to the top
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Every current student gets a notification.</p>
        <button type="submit" disabled={!canPost} className={primaryButton}>
          Post
        </button>
      </div>
    </form>
  );
}

function EditForm({
  notice,
  busy,
  onSave,
  onCancel,
}: {
  notice: Announcement;
  busy: boolean;
  onSave: (changes: AnnouncementChanges) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(notice.title);
  const [body, setBody] = useState(notice.body);
  // Only what changed is sent.
  const changes: AnnouncementChanges = {
    ...(title.trim() !== notice.title && { title: title.trim() }),
    ...(body.trim() !== notice.body && { body: body.trim() }),
  };
  const canSave = !busy && fits(title, TITLE_MAX) && fits(body, BODY_MAX) && Object.keys(changes).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) void onSave(changes);
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Edit ${notice.title}`}
      className="space-y-3 rounded-card border border-indigo-400/40 bg-surface p-4 shadow-card"
    >
      <TextField label="Title" value={title} max={TITLE_MAX} onChange={setTitle} />
      <TextField label="Notice" value={body} max={BODY_MAX} multiline onChange={setBody} />
      <p className="text-xs text-muted">Editing does not notify students again.</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={!canSave} className={primaryButton}>
          Save
        </button>
      </div>
    </form>
  );
}
