import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { getHostelSettings, setFeesStartDate, type HostelSettings } from "../api/hostels";
import { buttonClass, fieldClass } from "../ui";

// Settings > Fees and limits (multi-tenant phase 5a): the day this hostel's fee tracking
// starts, and how much of its limits it uses. Fee rows are created for due dates from the
// start date on; nothing is created before one is set.
const errorText = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong. Please try again.");

// "2026-12-01" -> "1 December 2026"
const longDate = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });

export function HostelFeesAndLimits() {
  const [settings, setSettings] = useState<HostelSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { heading: useId(), date: useId(), hint: useId() };

  useEffect(() => {
    let current = true;
    getHostelSettings()
      .then((s) => {
        if (!current) return;
        setSettings(s);
        setDate(s.feesStartDate ?? "");
      })
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !settings || !date || date === settings.feesStartDate) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await setFeesStartDate(date);
      setSettings({ ...settings, feesStartDate: date });
      setMessage(`Saved. Fees are tracked for due dates from ${longDate(date)}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={ids.heading} className="mx-auto mt-6 max-w-2xl space-y-4 rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id={ids.heading} className="font-display text-xl font-extrabold tracking-tight text-ink">
        Fees and limits
      </h2>
      {loadError && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {loadError}
        </p>
      )}
      {settings && (
        <>
          <form onSubmit={submit} className="space-y-3">
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
            <div>
              <label htmlFor={ids.date} className="block text-sm font-medium text-muted">
                Fees start on
              </label>
              <input
                id={ids.date}
                type="date"
                required
                min="2020-01-01"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-describedby={ids.hint}
                className={`${fieldClass} mt-1`}
              />
              <p id={ids.hint} className="mt-1 text-sm text-muted">
                {settings.feesStartDate
                  ? "Fees are created for due dates from this day. Moving it later keeps the fees already created; moving it earlier adds the ones in between."
                  : "Fees are not tracked yet. Choose the first due date to track: earlier payments stay in your own records."}
              </p>
            </div>
            <button type="submit" disabled={busy || !date || date === settings.feesStartDate} className={buttonClass("primary")}>
              {busy ? "Saving…" : settings.feesStartDate ? "Change start date" : "Start tracking fees"}
            </button>
          </form>

          <dl className="grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
            <Usage label="Current students" used={settings.usage.students} limit={settings.limits.students} />
            <Usage label="Buildings" used={settings.usage.buildings} limit={settings.limits.buildings} />
          </dl>
          <p className="text-sm text-muted">Need more? Ask HostelConnect to raise your limits.</p>
        </>
      )}
    </section>
  );
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number }) {
  const full = used >= limit;
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={`mt-0.5 font-semibold ${full ? "text-danger" : "text-ink"}`}>
        {used} of {limit}
        {full && " (full)"}
      </dd>
    </div>
  );
}
