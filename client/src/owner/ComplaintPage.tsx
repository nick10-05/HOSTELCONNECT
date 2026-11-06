import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  addComplaintNote,
  changeComplaintStatus,
  COMPLAINT_PRIORITIES,
  getOwnerComplaint,
  NOTE_MAX,
  noteLength,
  setComplaintPriority,
  type ComplaintPriority,
  type ComplaintStatus,
  type OwnerComplaintDetail,
} from "../api/complaints";
import { ComplaintPhoto } from "../components/ComplaintPhoto";
import { ComplaintTimeline } from "../components/ComplaintTimeline";
import {
  categoryLabel,
  formatTime,
  PriorityBadge,
  priorityLabel,
  StatusBadge,
  statusLabel,
} from "../components/complaintText";
import { inputClass, primaryButton, secondaryButton } from "./styles";

// One complaint, as the owner works on it (design doc, sections 4 and 9): set the
// priority, move the status, add a one-way note. The moves offered are exactly the
// server's `allowedMoves`; the page keeps no copy of the rules. Every change answers with
// the complaint as it is now, and the page redraws from that. The photo (day 8) shows with
// a countdown to its deletion.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

// The button for each move. Rejecting and reopening need a note (section 4).
const MOVES: Record<ComplaintStatus, { button: string; heading: string; noteRequired: boolean }> = {
  in_progress: { button: "Start work", heading: "Start work on this complaint", noteRequired: false },
  resolved: { button: "Resolve", heading: "Resolve this complaint", noteRequired: false },
  rejected: { button: "Reject", heading: "Reject this complaint", noteRequired: true },
  open: { button: "Reopen", heading: "Reopen this complaint", noteRequired: true },
};

export function ComplaintPage() {
  const { id } = useParams();
  const [complaint, setComplaint] = useState<OwnerComplaintDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The result of the last action: a confirmation or the server's refusal.
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const [move, setMove] = useState<ComplaintStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;
    setLoadError(null);
    getOwnerComplaint(id!)
      .then((c) => current && setComplaint(c))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, [id, reloads]);

  // Runs one change: shows the complaint the server sends back, or its refusal. A
  // complaint that changed since the page was loaded gets a Reload button.
  const run = async (action: () => Promise<OwnerComplaintDetail>, done: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setComplaint(await action());
      setNotice(done);
      return true;
    } catch (err) {
      setError({ message: errorText(err), stale: err instanceof ApiError && err.code === "status_changed" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    setError(null);
    setNotice(null);
    setMove(null);
    setReloads((n) => n + 1);
  };

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <BackLink />
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </p>
      </div>
    );
  }
  if (!complaint) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <BackLink />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <BackLink />

      <section
        aria-labelledby="complaint-heading"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 id="complaint-heading" className="text-xl font-semibold text-slate-900">
            {categoryLabel[complaint.category]} #{complaint.id}
          </h1>
          <div className="flex gap-2">
            <StatusBadge status={complaint.status} />
            <PriorityBadge priority={complaint.priority} />
          </div>
        </div>
        <p className="whitespace-pre-line break-words text-slate-800">{complaint.description}</p>
        <p className="text-sm text-slate-500">
          Raised {formatTime(complaint.createdAt)}
          {complaint.resolvedAt && ` · resolved ${formatTime(complaint.resolvedAt)}`}
        </p>
        <p className="text-sm text-slate-700">
          <Link to={`/students/${complaint.student.id}`} className="font-medium text-indigo-700 hover:underline">
            {complaint.student.name}
          </Link>
          {" · "}
          {complaint.place
            ? [complaint.place.buildingName, complaint.place.roomNumber && `Room ${complaint.place.roomNumber}`]
                .filter(Boolean)
                .join(" · ")
            : "Moved out"}
        </p>
        <ComplaintPhoto photo={complaint.photo} countdown />
      </section>

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          <p>{error.message}</p>
          {error.stale && (
            <button type="button" onClick={reload} className={secondaryButton}>
              Reload
            </button>
          )}
        </div>
      )}

      <section aria-labelledby="actions-heading" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 id="actions-heading" className="text-sm font-semibold text-slate-700">
          Work on it
        </h2>

        <PriorityPicker
          value={complaint.priority}
          disabled={busy}
          onChange={(priority) =>
            void run(() => setComplaintPriority(complaint.id, priority), `${priorityLabel[priority]} saved.`)
          }
        />

        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Status</p>
          {complaint.allowedMoves.length === 0 ? (
            <p className="text-sm text-slate-500">A rejected complaint is final.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {complaint.allowedMoves.map((to) => (
                <button
                  key={to}
                  type="button"
                  disabled={busy}
                  aria-pressed={move === to}
                  onClick={() => {
                    setMove(to);
                    setNotice(null);
                    setError(null);
                  }}
                  className={move === to ? primaryButton : secondaryButton}
                >
                  {MOVES[to].button}
                </button>
              ))}
            </div>
          )}
          {move && (
            <NoteForm
              key={move}
              label={MOVES[move].heading}
              hint={MOVES[move].noteRequired ? "a note is required; the student will see it" : "note optional; the student will see it"}
              required={MOVES[move].noteRequired}
              submitLabel={MOVES[move].button}
              busy={busy}
              onCancel={() => setMove(null)}
              onSubmit={async (note) => {
                const to = move;
                const ok = await run(
                  () => changeComplaintStatus(complaint.id, { from: complaint.status, to, note: note || null }),
                  `Status changed to ${statusLabel[to]}.`,
                );
                if (ok) setMove(null);
                return ok;
              }}
            />
          )}
        </div>

        <NoteForm
          label="Add a note"
          hint="the student will see it"
          required
          submitLabel="Add note"
          busy={busy}
          onSubmit={(note) => run(() => addComplaintNote(complaint.id, note), "Note added.")}
        />
      </section>

      <ComplaintTimeline events={complaint.events} viewer="owner" />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/complaints" className="text-sm font-medium text-indigo-700 hover:underline">
      ← Complaints
    </Link>
  );
}

function PriorityPicker({
  value,
  disabled,
  onChange,
}: {
  value: ComplaintPriority;
  disabled: boolean;
  onChange: (priority: ComplaintPriority) => void;
}) {
  const id = useId();
  return (
    <div className="max-w-xs">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        Priority <span className="font-normal text-slate-500">(only you see it)</span>
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ComplaintPriority)}
        className={inputClass}
      >
        {COMPLAINT_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {priorityLabel[p]}
          </option>
        ))}
      </select>
    </div>
  );
}

// A note box with a counter. Required: the button stays off until something is written.
// The note is sent trimmed; the student will read it on the complaint's page.
function NoteForm({
  label,
  hint,
  required,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  hint: string;
  required: boolean;
  submitLabel: string;
  busy: boolean;
  onSubmit: (note: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const length = noteLength(note);
  const tooLong = length > NOTE_MAX;
  const canSend = !busy && !tooLong && (!required || length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    if (await onSubmit(note.trim())) setNote("");
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label} <span className="font-normal text-slate-500">({hint})</span>
      </label>
      <textarea
        id={id}
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-invalid={tooLong}
        className={inputClass}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-xs ${tooLong ? "text-red-700" : "text-slate-500"}`}>
          {length} / {NOTE_MAX}
        </span>
        <div className="flex gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} className={secondaryButton}>
              Cancel
            </button>
          )}
          <button type="submit" disabled={!canSend} className={primaryButton}>
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
