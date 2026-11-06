import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { getMyFees, type MyFeeRow, type MyFees } from "../api/fees";
import { formatDate, formatRupees } from "../owner/format";

// A student's own fees (design doc, sections 3 and 9; day 9): what is to pay now (pending
// fees due on or before today), what is overdue, the next due date, and every fee with its
// state. A "payment recorded" notification opens this page. MyFeesCard is the short
// version on the home page. The hostel's UPI details are added with the payment settings.

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

export function MyFeesPage() {
  const { fees, error } = useMyFees();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">My fees</h1>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !fees ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <section
            aria-labelledby="fees-now"
            className="space-y-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <h2 id="fees-now" className="text-sm font-semibold text-slate-700">
              To pay now
            </h2>
            {nothingDue(fees) ? (
              <p className="text-slate-700">Nothing to pay right now.</p>
            ) : (
              <p className="text-3xl font-semibold tabular-nums text-slate-900">{formatRupees(fees.pendingBalance)}</p>
            )}
            {fees.overdue.length > 0 && <p className="text-sm font-medium text-red-700">{overdueText(fees.overdue.length)}</p>}
            {fees.amountNotSet > 0 && <p className="text-sm text-amber-800">{notSetText(fees.amountNotSet)}</p>}
            {fees.nextDueDate && (
              <p className="text-sm text-slate-600">Next due date: {formatDate(fees.nextDueDate)}</p>
            )}
          </section>

          {fees.history.length === 0 ? (
            <p className="text-sm text-slate-600">No fees yet.</p>
          ) : (
            <ul aria-label="My fees" className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
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
function stateOf(fee: MyFeeRow, fees: MyFees): [string, string] {
  if (fee.status === "paid") return ["Paid", "bg-emerald-50 text-emerald-700"];
  if (fees.overdue.some((r) => r.id === fee.id)) return ["Overdue", "bg-red-50 text-red-700"];
  if (fees.upcoming.some((r) => r.id === fee.id)) return ["Upcoming", "bg-slate-100 text-slate-600"];
  return ["Due today", "bg-amber-50 text-amber-800"];
}

function FeeItem({ fee, fees }: { fee: MyFeeRow; fees: MyFees }) {
  const [label, badgeClass] = stateOf(fee, fees);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
      <div>
        <p className="font-medium text-slate-900">Due {formatDate(fee.dueDate)}</p>
        {fee.paidOn && (
          <p className="text-sm text-emerald-800">
            Paid on {formatDate(fee.paidOn)}
            {fee.note && ` · ${fee.note}`}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {fee.amount === null ? (
          <span className="text-sm text-amber-800">Amount not set</span>
        ) : (
          <span className="font-semibold tabular-nums text-slate-900">{formatRupees(fee.amount)}</span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass}`}>{label}</span>
      </div>
    </li>
  );
}

// The fees part of the student's home (section 9: "My fees (pending balance, next due
// date...)"). Nothing at all when the fees cannot be loaded; the full page says why.
export function MyFeesCard() {
  const { fees } = useMyFees();
  if (!fees) return null;
  return (
    <section
      aria-labelledby="my-fees-card"
      className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="my-fees-card" className="text-sm font-semibold text-slate-700">
          My fees
        </h2>
        <Link to="/fees" className="text-sm font-medium text-indigo-700 hover:underline">
          See my fees
        </Link>
      </div>
      {nothingDue(fees) ? (
        <p className="text-slate-700">Nothing to pay right now.</p>
      ) : (
        <dl>
          <dt className="text-sm text-slate-600">To pay now</dt>
          <dd className="text-2xl font-semibold tabular-nums text-slate-900">{formatRupees(fees.pendingBalance)}</dd>
        </dl>
      )}
      {fees.overdue.length > 0 && <p className="text-sm font-medium text-red-700">{overdueText(fees.overdue.length)}</p>}
      {fees.amountNotSet > 0 && <p className="text-sm text-amber-800">{notSetText(fees.amountNotSet)}</p>}
      {fees.nextDueDate && <p className="text-sm text-slate-600">Next due date: {formatDate(fees.nextDueDate)}</p>}
    </section>
  );
}
