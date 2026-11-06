import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
  listFees,
  markFeePaid,
  markFeePending,
  NOTE_MAX,
  noteLength,
  type FeeFilter,
  type FeeList,
  type FeeState,
  type FeeTotal,
  type OwnerFeeRow,
} from "../api/fees";
import { getStructure, type Building } from "../api/structure";
import { formatDate, formatRupees } from "./format";
import { inputClass, primaryButton, secondaryButton } from "./styles";

// The owner's fees (design doc, sections 2, 3 and 9; day 9): one month's fee rows (India's
// current month unless one is picked), with the month's totals, filtered by state and
// building. The filters and page are in the address (?month=, ?status=, ?building=,
// ?page=). He marks a fee paid, with an optional payment date (today when left empty) and
// note, which notifies the student; or marks a paid fee not paid again, after confirming,
// which clears the date and note and notifies nobody.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const smallButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60";

const STATUSES = [
  ["paid", "Paid"],
  ["pending", "Pending"],
  ["overdue", "Overdue"],
] as const;
type StatusFilter = (typeof STATUSES)[number][0];

const STATE_BADGE: Record<FeeState, [string, string]> = {
  paid: ["Paid", "bg-emerald-50 text-emerald-700"],
  overdue: ["Overdue", "bg-red-50 text-red-700"],
  due: ["Due today", "bg-amber-50 text-amber-800"],
  upcoming: ["Upcoming", "bg-slate-100 text-slate-600"],
};

const feesText = (n: number) => `${n} ${n === 1 ? "fee" : "fees"}`;

export function FeesPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? "";
  const statusParam = params.get("status") ?? "";
  const status = STATUSES.some(([value]) => value === statusParam) ? (statusParam as StatusFilter) : undefined;
  const building = params.get("building") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [data, setData] = useState<FeeList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [reloads, setReloads] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [marking, setMarking] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const monthId = useId();
  const statusId = useId();
  const buildingId = useId();

  useEffect(() => {
    let current = true;
    setLoadError(null);
    const filter: FeeFilter = {
      month: month || undefined,
      status,
      buildingId: building ? Number(building) : undefined,
      page,
    };
    listFees(filter)
      .then((d) => current && setData(d))
      .catch((err: unknown) => current && setLoadError(errorText(err)));
    return () => {
      current = false;
    };
  }, [month, status, building, page, reloads]);

  // Only for the building filter; without it the filter is simply not offered.
  useEffect(() => {
    let current = true;
    getStructure()
      .then((b) => current && setBuildings(b))
      .catch(() => current && setBuildings([]));
    return () => {
      current = false;
    };
  }, []);

  // A new filter starts again at page 1; the others are kept.
  const filterBy = (changes: { month?: string; status?: string; building?: string }) => {
    const next = { month, status: status ?? "", building, ...changes };
    const query: Record<string, string> = {};
    if (next.month) query.month = next.month;
    if (next.status) query.status = next.status;
    if (next.building) query.building = next.building;
    setParams(query);
  };
  const goToPage = (n: number) => {
    const query = Object.fromEntries(params);
    if (n > 1) query.page = String(n);
    else delete query.page;
    setParams(query);
  };

  // Runs one change, then reloads the list (the row's state and the totals change).
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    setActionError(null);
    try {
      await action();
      setMarking(null);
      setConfirming(null);
      setMessage(done);
      setReloads((n) => n + 1);
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Fees</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={monthId} className="block text-sm font-medium text-slate-700">
            Month
          </label>
          <input
            id={monthId}
            type="month"
            value={month}
            onChange={(e) => filterBy({ month: e.target.value })}
            className={inputClass}
          />
        </div>
        <button type="button" onClick={() => filterBy({ month: "" })} className={secondaryButton}>
          This month
        </button>
        <div className="space-y-1">
          <label htmlFor={statusId} className="block text-sm font-medium text-slate-700">
            Show
          </label>
          <select
            id={statusId}
            value={status ?? ""}
            onChange={(e) => filterBy({ status: e.target.value })}
            className={inputClass}
          >
            <option value="">All fees</option>
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {buildings.length > 0 && (
          <div className="space-y-1">
            <label htmlFor={buildingId} className="block text-sm font-medium text-slate-700">
              Building
            </label>
            <select
              id={buildingId}
              value={building}
              onChange={(e) => filterBy({ building: e.target.value })}
              className={inputClass}
            >
              <option value="">All buildings</option>
              {buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {message && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {message}
        </p>
      )}

      {loadError ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {loadError}
        </p>
      ) : !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <section aria-label="Totals" className="space-y-2">
            <dl className="grid grid-cols-3 gap-3">
              <Total label="Paid" total={data.totals.paid} />
              <Total label="Pending" total={data.totals.pending} />
              <Total label="Overdue" total={data.totals.overdue} />
            </dl>
            {data.totals.amountNotSet > 0 && (
              <p className="text-sm text-amber-800">
                {data.totals.amountNotSet === 1
                  ? "1 pending fee has no amount set."
                  : `${data.totals.amountNotSet} pending fees have no amount set.`}
              </p>
            )}
          </section>

          {data.items.length === 0 ? (
            <p className="text-sm text-slate-600">No fees match.</p>
          ) : (
            <ul aria-label="Fees" className="space-y-3">
              {data.items.map((f) => (
                <li key={f.id} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <FeeSummary fee={f} />
                  {marking === f.id ? (
                    <MarkPaidForm
                      fee={f}
                      busy={busy}
                      error={actionError}
                      onCancel={() => setMarking(null)}
                      onSave={(paidOn, note) =>
                        void run(
                          () => markFeePaid(f.id, paidOn || undefined, note),
                          f.isActive ? `Marked paid. ${f.studentName} has been notified.` : "Marked paid.",
                        )
                      }
                    />
                  ) : confirming === f.id ? (
                    <div role="group" aria-label="Confirm not paid" className="space-y-2 rounded-lg bg-amber-50 p-3">
                      <p className="text-sm text-amber-900">
                        The payment date and note are cleared. {f.studentName} is not notified.
                      </p>
                      {actionError && (
                        <p role="alert" className="text-sm text-red-700">
                          {actionError}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => markFeePending(f.id), "Marked not paid.")}
                          className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
                        >
                          Yes, mark not paid
                        </button>
                        <button type="button" className={smallButton} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {f.status === "pending" ? (
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() => {
                            setActionError(null);
                            setConfirming(null);
                            setMarking(f.id);
                          }}
                        >
                          Mark paid
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          className={smallButton}
                          onClick={() => {
                            setActionError(null);
                            setMarking(null);
                            setConfirming(f.id);
                          }}
                        >
                          Mark not paid
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <button type="button" className={pageButton} disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {page} of {pages}
              </span>
              <button type="button" className={pageButton} disabled={page >= pages} onClick={() => goToPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function Total({ label, total }: { label: string; total: FeeTotal }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-slate-900">{formatRupees(total.amount)}</dd>
      <dd className="text-xs text-slate-500">{feesText(total.count)}</dd>
    </div>
  );
}

function FeeSummary({ fee }: { fee: OwnerFeeRow }) {
  const [label, badgeClass] = STATE_BADGE[fee.state];
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <Link to={`/students/${fee.studentId}`} className="font-medium text-slate-900 hover:underline">
            {fee.studentName}
          </Link>
          {!fee.isActive && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">Moved out</span>
          )}
        </p>
        <p className="text-sm text-slate-500">
          {[fee.buildingName, `Due ${formatDate(fee.dueDate)}`].filter(Boolean).join(" · ")}
        </p>
        {fee.paidOn && (
          <p className="text-sm text-emerald-800">
            Paid on {formatDate(fee.paidOn)}
            {fee.note && ` · ${fee.note}`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-semibold tabular-nums text-slate-900">
          {fee.amount === null ? <span className="text-sm font-normal text-amber-800">Amount not set</span> : formatRupees(fee.amount)}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}>{label}</span>
      </div>
    </div>
  );
}

function MarkPaidForm({
  fee,
  busy,
  error,
  onCancel,
  onSave,
}: {
  fee: OwnerFeeRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (paidOn: string, note: string) => void;
}) {
  const [paidOn, setPaidOn] = useState("");
  const [note, setNote] = useState("");
  const dateId = useId();
  const noteId = useId();
  const countId = useId();
  const length = noteLength(note);
  const tooLong = length > NOTE_MAX;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!tooLong) onSave(paidOn, note);
  };

  return (
    <form onSubmit={submit} aria-label={`Mark paid: ${fee.studentName}`} className="space-y-3 rounded-lg bg-slate-50 p-3">
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label htmlFor={dateId} className="block text-sm font-medium text-slate-700">
            Paid on
          </label>
          <input id={dateId} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputClass} />
          <p className="text-xs text-slate-500">Leave the date empty for today.</p>
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={noteId} className="block text-sm font-medium text-slate-700">
            Note (optional)
          </label>
          <input
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Paid by UPI"
            aria-invalid={tooLong}
            aria-describedby={countId}
            className={inputClass}
          />
          <p id={countId} className={`text-xs ${tooLong ? "text-red-600" : "text-slate-500"}`}>
            {length} / {NOTE_MAX}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || tooLong} className={primaryButton}>
          Save
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
