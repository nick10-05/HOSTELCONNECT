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
import { ListSkeleton, Pager } from "../ui/ListParts";

// The owner's review of requests from former students (design doc, sections 5 and 9).
// Pending requests wait oldest first; approving reactivates the student (a joining date
// and a place, a new temporary password shown once) and closes the request in one go;
// rejecting only closes it. The tab and page are in the address, as on the Students page.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const dangerButton =
  "press inline-flex min-h-11 items-center justify-center rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60";
const tabClass = (active: boolean) =>
  `press min-h-11 rounded-full px-4 text-sm font-semibold ${
    active ? "hc-pill-violet" : "text-muted hover:bg-soft hover:text-ink"
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
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink md:text-4xl">Rejoin requests</h1>

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
          className="space-y-4 rounded-card border border-emerald-400/40 bg-surface p-4 shadow-card"
        >
          <h2 id="request-approved-heading" className="text-base font-bold text-ink">
            Request approved
          </h2>
          <p className="text-muted">
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
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          {notice}
        </p>
      )}

      {error ? (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      ) : !result ? (
        <ListSkeleton label="Loading requests…" rows={3} />
      ) : result.total === 0 ? (
        <p className="text-sm text-muted">
          {status === "pending" ? "No requests are waiting." : "No requests have been decided yet."}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
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
          <Pager page={page} pages={pages} onPage={(n) => show({ page: n })} />
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
    <li aria-labelledby={nameId} className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link id={nameId} to={`/students/${r.student.id}`} className="font-medium text-accent hover:underline">
            {r.student.name}
          </Link>
          <p className="text-sm text-muted">{r.student.email}</p>
          <p className="text-sm text-muted">
            {r.student.leftOn ? `Left on ${formatDate(r.student.leftOn)} · asked` : "Asked"} on{" "}
            {formatDate(r.requestedOn)}
          </p>
        </div>
        {r.status !== "pending" && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              r.status === "approved" ? "hc-pill-green" : "hc-pill-grey"
            }`}
          >
            {r.status === "approved" ? "Approved" : "Rejected"}
          </span>
        )}
      </div>

      <p className={r.message ? "whitespace-pre-line text-ink" : "text-sm text-muted"}>
        {r.message ?? "No message."}
      </p>

      {r.status !== "pending" ? (
        <p className="text-sm text-muted">
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
    <div className="space-y-3 rounded-2xl border border-red-400/40 p-3">
      <p className="text-muted">{`Reject the request from ${r.student.name}? Nothing else changes.`}</p>
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
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
