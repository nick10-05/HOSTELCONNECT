import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getMyFees, type MyFeeRow, type MyFees } from "../api/fees";
import { getPaymentSettings, type PaymentSettings } from "../api/settings";
import { PaymentDetails } from "../components/PaymentQr";
import { formatDate, formatRupees } from "../owner/format";
import { Alert, EmptyState, IconTile, Pill, type PillTone } from "../ui";
import { CheckIcon, ChevronRightIcon, ClockIcon, RupeeIcon, WarningIcon } from "../ui/icons";
import { listClass, ListSkeleton, PageHeader } from "../ui/ListParts";

// A student's own fees (design doc, sections 3 and 9; day 9): what is to pay now (pending
// fees due on or before today), what is overdue, the next due date, and every fee with its
// state. A "payment recorded" notification opens this page. MyFeesCard is the short
// version on the home page. "Pay the hostel" (PaymentDetails) shows the owner's UPI ID and
// QR, with the amount to pay now in the drawn QR and the UPI app link.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const overdueText = (n: number) => (n === 1 ? "1 fee is overdue." : `${n} fees are overdue.`);
const notSetText = (n: number) =>
  `${n === 1 ? "1 fee has" : `${n} fees have`} no amount set yet. Ask the hostel.`;
const nothingDue = (f: MyFees) => f.pendingBalance === 0 && f.amountNotSet === 0;

// Loads the student's fees once. `error` is null while loading or after success.
function useMyFees() {
  const [fees, setFees] = useState<MyFees | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getMyFees()
      .then((f) => current && setFees(f))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, []);
  return { fees, error };
}

// The lines under the amount: overdue, no amount set, the next due date. On the gradient
// card (the page) or a plain one (the home card).
function FeeNotes({ fees, onHero = false }: { fees: MyFees; onHero?: boolean }) {
  const chip = onHero
    ? "border border-[var(--hc-chip-line)] bg-[var(--hc-chip)] text-hero-ink"
    : "bg-soft text-ink";
  return (
    <div className="flex flex-wrap gap-2">
      {fees.overdue.length > 0 && (
        <p className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${onHero ? chip : "hc-pill-red"}`}>
          <WarningIcon size={14} />
          {overdueText(fees.overdue.length)}
        </p>
      )}
      {fees.amountNotSet > 0 && (
        <p className={`rounded-full px-3 py-1 text-xs font-semibold ${onHero ? chip : "hc-pill-amber"}`}>
          {notSetText(fees.amountNotSet)}
        </p>
      )}
      {fees.nextDueDate && (
        <p className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${chip}`}>
          <ClockIcon size={14} />
          Next due date: {formatDate(fees.nextDueDate)}
        </p>
      )}
    </div>
  );
}

export function MyFeesPage() {
  const { fees, error } = useMyFees();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="My fees" />
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !fees ? (
        <ListSkeleton label="Loading your fees…" rows={3} />
      ) : (
        <>
          <section
            aria-labelledby="fees-now"
            className="rise bg-hero relative space-y-3 overflow-hidden rounded-[1.75rem] p-5 shadow-[var(--hc-hero-shadow)] md:p-6"
          >
            <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/15 blur-2xl" />
            <h2 id="fees-now" className="relative text-sm font-semibold text-hero-muted">
              To pay now
            </h2>
            {nothingDue(fees) ? (
              <p className="relative flex items-center gap-2 font-display text-2xl font-extrabold text-hero-ink">
                <CheckIcon />
                Nothing to pay right now.
              </p>
            ) : (
              <p className="relative font-display text-4xl font-extrabold tracking-tight tabular-nums text-hero-ink md:text-5xl">
                {formatRupees(fees.pendingBalance)}
              </p>
            )}
            <div className="relative">
              <FeeNotes fees={fees} onHero />
            </div>
          </section>

          <PaymentDetails amount={fees.pendingBalance} />

          {fees.history.length === 0 ? (
            <EmptyState title="No fees yet." tone="green" icon={<RupeeIcon />} />
          ) : (
            <ul aria-label="My fees" className={listClass}>
              {fees.history.map((f) => (
                <FeeItem key={f.id} fee={f} fees={fees} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// A row's state, from the lists the server already split by India's today: a pending row
// that is neither overdue nor upcoming is due today.
function stateOf(fee: MyFeeRow, fees: MyFees): [string, PillTone] {
  if (fee.status === "paid") return ["Paid", "green"];
  if (fees.overdue.some((r) => r.id === fee.id)) return ["Overdue", "red"];
  if (fees.upcoming.some((r) => r.id === fee.id)) return ["Upcoming", "grey"];
  return ["Due today", "amber"];
}

function FeeItem({ fee, fees }: { fee: MyFeeRow; fees: MyFees }) {
  const [label, tone] = stateOf(fee, fees);
  return (
    <li className="flex items-center gap-3 px-4 py-3.5">
      <IconTile tone={fee.status === "paid" ? "green" : tone === "red" ? "red" : "violet"} size="sm">
        {fee.status === "paid" ? <CheckIcon size={18} /> : <RupeeIcon size={18} />}
      </IconTile>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">Due {formatDate(fee.dueDate)}</p>
        {fee.paidOn && (
          <p className="text-sm font-medium text-success">
            Paid on {formatDate(fee.paidOn)}
            {fee.note && ` · ${fee.note}`}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {fee.amount === null ? (
          <span className="text-sm font-semibold text-warn">Amount not set</span>
        ) : (
          <span className="font-display font-extrabold tabular-nums text-ink">{formatRupees(fee.amount)}</span>
        )}
        <Pill tone={tone}>{label}</Pill>
      </div>
    </li>
  );
}

// The fees part of the student's home (section 9: "My fees (pending balance, next due
// date, the owner's UPI details)"): the UPI ID only; the QR is on the full page. Nothing at
// all when the fees cannot be loaded (the full page says why); no UPI line when there is
// no UPI ID or it cannot be loaded.
export function MyFeesCard() {
  const { fees } = useMyFees();
  const [payment, setPayment] = useState<PaymentSettings | null>(null);
  useEffect(() => {
    let current = true;
    getPaymentSettings()
      .then((s) => current && setPayment(s))
      .catch(() => current && setPayment(null));
    return () => {
      current = false;
    };
  }, []);

  if (!fees) return null;
  return (
    <section
      aria-labelledby="my-fees-card"
      className="rise space-y-3 rounded-card border border-line bg-surface p-4 shadow-card md:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <IconTile tone="green" size="sm">
            <RupeeIcon size={18} />
          </IconTile>
          <h2 id="my-fees-card" className="text-base font-bold text-ink">
            My fees
          </h2>
        </div>
        <Link to="/fees" className="inline-flex min-h-11 items-center gap-0.5 text-sm font-semibold text-accent hover:underline">
          See my fees
          <ChevronRightIcon size={16} />
        </Link>
      </div>
      {nothingDue(fees) ? (
        <p className="font-semibold text-ink">Nothing to pay right now.</p>
      ) : (
        <dl>
          <dt className="text-sm text-muted">To pay now</dt>
          <dd className="font-display text-3xl font-extrabold tracking-tight tabular-nums text-ink">
            {formatRupees(fees.pendingBalance)}
          </dd>
        </dl>
      )}
      <FeeNotes fees={fees} />
      {payment?.upiId && (
        <p className="rounded-xl bg-soft px-3 py-2 text-sm font-medium break-all text-ink">
          Pay to {payment.upiId}
          {payment.upiPayeeName && ` (${payment.upiPayeeName})`}
        </p>
      )}
    </section>
  );
}
