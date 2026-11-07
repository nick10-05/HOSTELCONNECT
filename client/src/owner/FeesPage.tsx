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
import { Alert, Button, buttonClass, EmptyState, Pill, type PillTone } from "../ui";
import { CheckIcon, RupeeIcon, WarningIcon } from "../ui/icons";
import { Avatar, ListSkeleton, PageHeader, Pager, Segmented, SelectField } from "../ui/ListParts";
import { useToast } from "../ui/Toast";
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

const smallButton = `${buttonClass("secondary")} min-h-10 px-3`;

// "All" is no filter: the empty value.
const SHOW = [
  ["", "All"],
  ["paid", "Paid"],
  ["pending", "Pending"],
  ["overdue", "Overdue"],
] as const;
type StatusFilter = "paid" | "pending" | "overdue";
const isStatus = (v: string): v is StatusFilter => v === "paid" || v === "pending" || v === "overdue";

const STATE_BADGE: Record<FeeState, [string, PillTone]> = {
  paid: ["Paid", "green"],
  overdue: ["Overdue", "red"],
  due: ["Due today", "amber"],
  upcoming: ["Upcoming", "grey"],
};

const feesText = (n: number) => `${n} ${n === 1 ? "fee" : "fees"}`;

// '2032-07' → 'July 2032'; with no month, India's current one.
const monthName = (month: string) =>
  new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: month ? "UTC" : "Asia/Kolkata" }).format(
    month ? new Date(`${month}-01T00:00:00Z`) : new Date(),
  );

export function FeesPage() {
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? "";
  const statusParam = params.get("status") ?? "";
  const status = isStatus(statusParam) ? statusParam : undefined;
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
  const toast = useToast();
  const monthId = useId();

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

  // Runs one change, then reloads the list (the row's state and the totals change). The
  // message goes in the pop-up at the top of the screen, or in the page without one.
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    setActionError(null);
    try {
      await action();
      setMarking(null);
      setConfirming(null);
      if (toast.available) toast.show(done);
      else setMessage(done);
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
      <PageHeader title="Fees" subtitle={monthName(month)} />

      <div className="space-y-3">
        <Segmented label="Show" options={SHOW} value={status ?? ""} onChange={(v) => filterBy({ status: v })} />
        <div className="grid grid-cols-[1fr_auto] items-end gap-3 sm:flex sm:flex-wrap">
          <div className="sm:w-48">
            <label htmlFor={monthId} className="mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">
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
          {buildings.length > 0 && (
            <div className="col-span-2 sm:w-56">
              <SelectField label="Building" value={building} onChange={(v) => filterBy({ building: v ?? "" })}>
                <option value="">All buildings</option>
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </SelectField>
            </div>
          )}
        </div>
      </div>

      {message && <Alert tone="success">{message}</Alert>}

      {loadError ? (
        <Alert tone="error">{loadError}</Alert>
      ) : !data ? (
        <ListSkeleton label="Loading fees…" />
      ) : (
        <>
          <section aria-label="Totals" className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Total label="Paid" total={data.totals.paid} look="hero" />
              <Total label="Pending" total={data.totals.pending} look="pending" />
              <Total label="Overdue" total={data.totals.overdue} look="overdue" />
            </dl>
            {data.totals.amountNotSet > 0 && (
              <p className="hc-pill-amber flex items-center gap-2 rounded-2xl px-3.5 py-2.5 text-sm font-medium">
                <WarningIcon size={18} />
                {data.totals.amountNotSet === 1
                  ? "1 pending fee has no amount set."
                  : `${data.totals.amountNotSet} pending fees have no amount set.`}
              </p>
            )}
          </section>

          {data.items.length === 0 ? (
            <EmptyState title="No fees match." tone="green" icon={<RupeeIcon />} />
          ) : (
            <ul aria-label="Fees" className="space-y-3">
              {data.items.map((f, i) => (
                <li
                  key={f.id}
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                  className="rise space-y-3 rounded-card border border-line bg-surface p-4 shadow-card"
                >
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
                    <div role="group" aria-label="Confirm not paid" className="hc-pill-amber space-y-3 rounded-2xl p-3">
                      <p className="text-sm">The payment date and note are cleared. {f.studentName} is not notified.</p>
                      {actionError && <Alert tone="error">{actionError}</Alert>}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="strong"
                          disabled={busy}
                          onClick={() => void run(() => markFeePending(f.id), "Marked not paid.")}
                        >
                          Yes, mark not paid
                        </Button>
                        <button type="button" className={smallButton} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 pl-14">
                      {f.status === "pending" ? (
                        <Button
                          disabled={busy}
                          className="min-h-10 px-3"
                          onClick={() => {
                            setActionError(null);
                            setConfirming(null);
                            setMarking(f.id);
                          }}
                        >
                          <CheckIcon size={18} />
                          Mark paid
                        </Button>
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

          <Pager page={page} pages={pages} onPage={goToPage} />
        </>
      )}
    </div>
  );
}

// Paid is the big gradient card; pending and overdue sit beside it.
const totalLook = {
  hero: { box: "bg-hero col-span-2 shadow-[var(--hc-hero-shadow)] md:col-span-1", label: "text-hero-muted", amount: "text-hero-ink", count: "text-hero-muted" },
  pending: { box: "border border-line bg-surface shadow-card", label: "text-muted", amount: "text-ink", count: "text-muted" },
  overdue: { box: "border border-line bg-surface shadow-card", label: "text-muted", amount: "text-danger", count: "text-muted" },
};

function Total({ label, total, look }: { label: string; total: FeeTotal; look: keyof typeof totalLook }) {
  const s = totalLook[look];
  return (
    <div className={`rise rounded-card p-4 ${s.box}`}>
      <dt className={`text-sm font-semibold ${s.label}`}>{label}</dt>
      <dd className={`font-display text-2xl font-extrabold tracking-tight tabular-nums md:text-3xl ${s.amount}`}>
        {formatRupees(total.amount)}
      </dd>
      <dd className={`text-xs font-medium ${s.count}`}>{feesText(total.count)}</dd>
    </div>
  );
}

function FeeSummary({ fee }: { fee: OwnerFeeRow }) {
  const [label, tone] = STATE_BADGE[fee.state];
  return (
    <div className="flex items-start gap-3">
      <Avatar name={fee.studentName} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <Link to={`/students/${fee.studentId}`} className="-my-2.5 inline-flex min-h-11 items-center font-semibold text-ink hover:underline">
            {fee.studentName}
          </Link>
          {!fee.isActive && <Pill tone="grey">Moved out</Pill>}
        </p>
        <p className="text-sm text-muted">
          {[fee.buildingName, `Due ${formatDate(fee.dueDate)}`].filter(Boolean).join(" · ")}
        </p>
        {fee.paidOn && (
          <p className="text-sm font-medium text-success">
            Paid on {formatDate(fee.paidOn)}
            {fee.note && ` · ${fee.note}`}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="font-display text-lg font-extrabold tabular-nums text-ink">
          {fee.amount === null ? (
            <span className="font-sans text-sm font-semibold text-warn">Amount not set</span>
          ) : (
            formatRupees(fee.amount)
          )}
        </span>
        <Pill tone={tone}>{label}</Pill>
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
    <form onSubmit={submit} aria-label={`Mark paid: ${fee.studentName}`} className="space-y-3 rounded-2xl bg-soft p-3">
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <label htmlFor={dateId} className="block text-sm font-semibold text-ink">
            Paid on
          </label>
          <input id={dateId} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputClass} />
          <p className="text-xs text-muted">Leave the date empty for today.</p>
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={noteId} className="block text-sm font-semibold text-ink">
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
          <p id={countId} className={`text-xs ${tooLong ? "font-semibold text-danger" : "text-muted"}`}>
            {length} / {NOTE_MAX}
          </p>
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
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
