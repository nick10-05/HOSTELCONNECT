import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  deleteWithCode,
  getDeletionPreview,
  requestDeletionCode,
  type DeletionKind,
  type DeletionPreview,
  type SentCode,
} from "../api/structure";
import { BottomSheet } from "../ui/BottomSheet";
import { buttonClass, fieldClass } from "../ui";

// Deleting a building or room for good, in a sheet over the structure page:
//   1. what would go (floors, rooms, beds, past stays), and the name typed to confirm;
//   2. a 6-digit code emailed to the owner (5 minutes; a new one after 60 seconds);
//   3. the code, checked by the server, which then deletes.
// The server checks everything again; this screen only explains and asks.

type Props = {
  target: { kind: DeletionKind; id: number } | null; // null: closed
  onClose: () => void;
  onDeleted: (name: string) => void;
};

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// 299 → "4:59"
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function DeleteWithCode({ target, onClose, onDeleted }: Props) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // A new target starts from the beginning.
  useEffect(() => {
    setPreview(null);
    setLoadError(null);
    if (!target) return;
    let current = true;
    getDeletionPreview(target.kind, target.id)
      .then((p) => current && setPreview(p))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, [target]);

  const title = target?.kind === "room" ? "Delete room" : "Delete building";
  return (
    <BottomSheet open={target !== null} title={title} onClose={onClose}>
      {loadError ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {loadError}
        </p>
      ) : preview === null ? (
        <p className="text-sm text-muted">Checking what would be deleted…</p>
      ) : (
        <Steps key={`${preview.kind}-${preview.id}`} preview={preview} onDeleted={onDeleted} />
      )}
    </BottomSheet>
  );
}

function Steps({ preview, onDeleted }: { preview: DeletionPreview; onDeleted: (name: string) => void }) {
  const [typed, setTyped] = useState("");
  const [sent, setSent] = useState<(SentCode & { sentAt: number }) | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // A clock for the code's time left and the wait before a new one.
  useEffect(() => {
    if (!sent) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sent]);

  const isBuilding = preview.kind === "building";
  const nameMatches = typed.trim().toLowerCase() === preview.confirmName.trim().toLowerCase();
  const secondsLeft = sent ? Math.max(0, Math.ceil((Date.parse(sent.expiresAt) - now) / 1000)) : 0;
  const resendIn = sent ? Math.max(0, Math.ceil((sent.sentAt + sent.resendAfterSeconds * 1000 - now) / 1000)) : 0;

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestDeletionCode(preview.kind, preview.id, typed.trim());
      setSent({ ...result, sentAt: Date.now() });
      setNow(Date.now());
      setCode("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sent) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWithCode(preview.kind, preview.id, { confirmName: typed.trim(), codeId: sent.codeId, code });
      onDeleted(preview.name);
    } catch (err) {
      setError(errorText(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  const what = [
    isBuilding && plural(preview.floors, "floor"),
    isBuilding && plural(preview.rooms, "room"),
    plural(preview.beds, "bed"),
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="space-y-2 text-sm text-ink">
        <p>
          <strong>{preview.name}</strong> will be deleted for good, with {what.join(", ")}. This cannot be undone.
        </p>
        {preview.pastStays > 0 && (
          <p className="text-muted">
            {plural(preview.pastStays, "past stay")} stay in the students' history, under the name {preview.name}.
          </p>
        )}
      </div>

      {preview.currentStays > 0 ? (
        <p role="alert" className="hc-pill-amber rounded-2xl px-3.5 py-3 text-sm font-medium">
          {plural(preview.currentStays, "student")} {preview.currentStays === 1 ? "lives" : "live"} here now or{" "}
          {preview.currentStays === 1 ? "is" : "are"} booked to join. Move them before deleting.
        </p>
      ) : !preview.emailReady ? (
        <p role="alert" className="hc-pill-amber rounded-2xl px-3.5 py-3 text-sm font-medium">
          Deleting needs a code sent by email, and email is not set up on the server yet.
        </p>
      ) : (
        <>
          <label className="block">
            <span className="block text-sm font-medium text-muted">
              Type {isBuilding ? "the building's name" : "the room number"}, <strong className="text-ink">{preview.confirmName}</strong>, to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={sent !== null}
              autoComplete="off"
              maxLength={100}
              className={`mt-1 ${fieldClass}`}
            />
          </label>

          {sent === null ? (
            <button type="button" onClick={sendCode} disabled={!nameMatches || busy} className={`w-full ${buttonClass("danger")}`}>
              Email me a code
            </button>
          ) : (
            <form onSubmit={confirm} className="space-y-3">
              <p className="text-sm text-ink" role="status">
                We sent a 6-digit code to <strong>{sent.sentTo}</strong>.{" "}
                {secondsLeft > 0 ? `It works for ${clock(secondsLeft)} more.` : "It has expired. Ask for a new one."}
              </p>
              <label className="block">
                <span className="block text-sm font-medium text-muted">Code from the email</span>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  required
                  className={`mt-1 ${fieldClass} tracking-[0.4em]`}
                />
              </label>
              <button
                type="submit"
                disabled={busy || code.length !== 6 || secondsLeft === 0}
                className={`w-full ${buttonClass("danger")}`}
              >
                Delete for good
              </button>
              <button
                type="button"
                onClick={sendCode}
                disabled={busy || resendIn > 0}
                className={`w-full ${buttonClass("secondary")}`}
              >
                {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
              </button>
            </form>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
