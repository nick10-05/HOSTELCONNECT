import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import {
  approveRejoinRequest,
  listRejoinRequests,
  rejectRejoinRequest,
  type RejoinRequestItem,
} from "../api/rejoin";
import type { Admission } from "../api/students";
import { formatDate } from "./format";
import { ReactivateForm } from "./ReactivateForm";
import { primaryButton, secondaryButton } from "./styles";
import { TemporaryPassword } from "./TemporaryPassword";

// The owner's review of requests from former students (design doc, sections 5 and 9).
// Pending requests wait oldest first; approving reactivates the student (a joining date
// and a place, a new temporary password shown once) and closes the request in one go;
// rejecting only closes it. The tab and page are in the address, as on the Students page.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const dangerButton =
  "rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60";
const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const tabClass = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;

type Open = { id: number; kind: "approve" | "reject" };

export function RejoinRequestsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") === "decided" ? "decided" : "pending";
  const page = Math.max(1, Number(params.get("page")) || 1);

  const [result, setResult] = useState<{ items: RejoinRequestItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a decision, so the list loads again.
  const [version, setVersion] = useState(0);
  // The one card with an open action, if any.
  const [open, setOpen] = useState<Open | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // After an approval: the temporary password, held only until the owner presses Done.
  const [approved, setApproved] = useState<Admission | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    listRejoinRequests(status, page)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [status, page, version]);

  const show = (next: { status?: string; page?: number }) => {
    setOpen(null);
    setNotice(null);
    setResult(null);
    const s = next.status ?? status;
    setParams({ ...(s === "decided" && { status: s }), ...(next.page && next.page > 1 && { page: String(next.page) }) });
  };

  const decided = (message: string | null) => {
    setOpen(null);
    setNotice(message);
    setVersion((v) => v + 1);
  };

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Rejoin requests</h1>

      <div role="group" aria-label="Show" className="flex gap-1">
        <button type="button" aria-pressed={status === "pending"} className={tabClass(status === "pending")} onClick={() => show({ status: "pending" })}>
          Pending
        </button>
        <button type="button" aria-pressed={status === "decided"} className={tabClass(status === "decided")} onClick={() => show({ status: "decided" })}>
          Decided
        </button>
      </div>

      {approved && (
        <section
          aria-labelledby="request-approved-heading"
          className="space-y-4 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm"
        >
          <h2 id="request-approved-heading" className="text-sm font-semibold text-slate-700">
            Request approved
          </h2>
          <p className="text-slate-700">
            <strong>{approved.student.name}</strong> can log in again now; the new stay starts on{" "}
            {formatDate(approved.student.joiningDate)}.
          </p>
          <TemporaryPassword password={approved.temporaryPassword} />
          {/* Done forgets the password: it is never shown again. */}
          <button type="button" onClick={() => setApproved(null)} className={primaryButton}>
            Done
          </button>
        </section>
      )}

      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !result ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : result.total === 0 ? (
        <p className="text-sm text-slate-600">
          {status === "pending" ? "No requests are waiting." : "No requests have been decided yet."}
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-600">
            {result.total} {status === "pending" ? "waiting" : "decided"}
          </p>
          <ul className="space-y-3">
            {result.items.map((r) => (
              <RequestCard
                key={r.id}
                request={r}
                open={open?.id === r.id ? open.kind : null}
                onOpen={(kind) => {
                  setNotice(null);
                  setOpen({ id: r.id, kind });
                }}
                onClose={() => setOpen(null)}
                onApproved={(admission) => {
                  setApproved(admission);
                  decided(null);
                }}
                onRejected={() => decided(`Request from ${r.student.name} rejected.`)}
              />
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <button type="button" className={pageButton} disabled={page <= 1} onClick={() => show({ page: page - 1 })}>
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {page} of {pages}
              </span>
              <button type="button" className={pageButton} disabled={page >= pages} onClick={() => show({ page: page + 1 })}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

function RequestCard({
  request: r,
  open,
  onOpen,
  onClose,
  onApproved,
  onRejected,
}: {
  request: RejoinRequestItem;
  open: Open["kind"] | null;
  onOpen: (kind: Open["kind"]) => void;
  onClose: () => void;
  onApproved: (admission: Admission) => void;
  onRejected: () => void;
}) {
  const nameId = `rejoin-request-${r.id}`;
  return (
    <li aria-labelledby={nameId} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link id={nameId} to={`/students/${r.student.id}`} className="font-medium text-indigo-700 hover:underline">
            {r.student.name}
          </Link>
          <p className="text-sm text-slate-600">{r.student.email}</p>
          <p className="text-sm text-slate-500">
            {r.student.leftOn ? `Left on ${formatDate(r.student.leftOn)} · asked` : "Asked"} on{" "}
            {formatDate(r.requestedOn)}
          </p>
        </div>
        {r.status !== "pending" && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              r.status === "approved" ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700"
            }`}
          >
            {r.status === "approved" ? "Approved" : "Rejected"}
          </span>
        )}
      </div>

      <p className={r.message ? "whitespace-pre-line text-slate-800" : "text-sm text-slate-500"}>
        {r.message ?? "No message."}
      </p>

      {r.status !== "pending" ? (
        <p className="text-sm text-slate-500">
          Decided on {formatDate(r.decidedOn!)}
          {r.decidedByName ? ` by ${r.decidedByName}` : ""}
        </p>
      ) : open === "approve" ? (
        <ReactivateForm
          studentId={r.student.id}
          leftOn={r.student.leftOn}
          title="Approve and reactivate"
          submitLabel="Approve"
          send={(form) => approveRejoinRequest(r.id, form)}
          onDone={onApproved}
          onCancel={onClose}
        />
      ) : open === "reject" ? (
        <RejectConfirm request={r} onDone={onRejected} onCancel={onClose} />
      ) : (
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => onOpen("approve")} className={primaryButton}>
            Approve
          </button>
          <button type="button" onClick={() => onOpen("reject")} className={secondaryButton}>
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

function RejectConfirm({
  request: r,
  onDone,
  onCancel,
}: {
  request: RejoinRequestItem;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await rejectRejoinRequest(r.id);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-red-200 p-3">
      <p className="text-slate-700">{`Reject the request from ${r.student.name}? Nothing else changes.`}</p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={confirm} disabled={busy} className={dangerButton}>
          {busy ? "Rejecting…" : "Yes, reject"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </div>
  );
}
