import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { getFoodCounts, type FoodCount, type FoodCounts } from "../api/food";
import { formatDate } from "./format";
import { inputClass, secondaryButton } from "./styles";

// The cook's counts (design doc, sections 2 and 9; day 8): how many eat veg and non-veg on
// a date, for all buildings and for each one. Today (India's) unless a date is picked;
// the picked date stays in the address (?date=), so a reload or a shared link shows the
// same day. The server decides who counts and moves non-veg students to veg on their
// veg days.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

// ISO order, as the server numbers weekdays: 1 = Monday ... 7 = Sunday.
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function FoodCountsPage() {
  const [params, setParams] = useSearchParams();
  const date = params.get("date") ?? undefined;
  const [data, setData] = useState<FoodCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dateId = useId();

  useEffect(() => {
    let current = true;
    setError(null);
    getFoodCounts(date)
      .then((d) => current && setData(d))
      .catch((err: unknown) => current && setError(errorText(err)));
    // A slower answer for a date no longer chosen is dropped.
    return () => {
      current = false;
    };
  }, [date]);

  const pick = (value: string) => setParams(value ? { date: value } : {});

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Food counts</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor={dateId} className="block text-sm font-medium text-slate-700">
            Date
          </label>
          <input
            id={dateId}
            type="date"
            value={date ?? data?.date ?? ""}
            onChange={(e) => pick(e.target.value)}
            className={inputClass}
          />
        </div>
        <button type="button" onClick={() => pick("")} className={secondaryButton}>
          Today
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <Counts data={data} />
      )}
    </div>
  );
}

function Counts({ data }: { data: FoodCounts }) {
  const weekday = WEEKDAY_NAMES[data.weekday - 1];
  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-slate-900">
          {weekday}, {formatDate(data.date)}
        </p>
        <p className="text-sm text-slate-500">Non-veg students who eat veg on {weekday}s are counted as veg.</p>
      </div>

      <section
        aria-labelledby="food-overall"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="food-overall" className="text-sm font-semibold text-slate-700">
          All buildings
        </h2>
        <Totals count={data.overall} />
      </section>

      <section
        aria-labelledby="food-buildings"
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      >
        <h2 id="food-buildings" className="text-sm font-semibold text-slate-700">
          By building
        </h2>
        {data.buildings.length === 0 ? (
          <p className="text-sm text-slate-700">
            No buildings yet. Add one on{" "}
            <Link to="/structure" className="font-medium text-indigo-700 underline">
              Buildings and rooms
            </Link>
            .
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th scope="col" className="py-1 font-medium">
                  Building
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Veg
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Non-veg
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.buildings.map((b) => (
                <tr key={b.buildingId}>
                  <th scope="row" className="py-2 text-left font-medium text-slate-900">
                    {b.buildingName}
                  </th>
                  <td className="py-2 text-right tabular-nums text-slate-900">{b.veg}</td>
                  <td className="py-2 text-right tabular-nums text-slate-900">{b.nonVeg}</td>
                  <td className="py-2 text-right tabular-nums text-slate-600">{b.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Totals({ count }: { count: FoodCount }) {
  return (
    <dl className="grid grid-cols-3 gap-3 text-center">
      {(
        [
          ["Veg", count.veg],
          ["Non-veg", count.nonVeg],
          ["Total", count.total],
        ] as const
      ).map(([label, n]) => (
        <div key={label} className="rounded-lg bg-slate-50 py-2">
          <dt className="text-sm text-slate-600">{label}</dt>
          <dd className="text-2xl font-semibold tabular-nums text-slate-900">{n}</dd>
        </div>
      ))}
    </dl>
  );
}
