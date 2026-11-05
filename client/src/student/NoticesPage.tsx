import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { listAnnouncements, type Announcement } from "../api/announcements";
import { ApiError } from "../api/client";
import { NoticeCard } from "../components/NoticeCard";

// The owner's notices, as a student reads them (design doc, sections 2 and 9): pinned
// first, then newest, urgent ones highlighted. Students only read; nothing here changes
// anything. The bell's announcement notifications open this page.

const PAGE_SIZE = 20; // the server's default page size

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const pageButton =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

export function NoticesPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [result, setResult] = useState<{ items: Announcement[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    listAnnouncements(page)
      .then((r) => current && setResult(r))
      .catch((err: unknown) => current && setError(errorText(err)));
    return () => {
      current = false;
    };
  }, [page]);

  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Notices</h1>
      {error ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : !result ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : result.total === 0 ? (
        <p className="text-sm text-slate-600">No notices yet.</p>
      ) : (
        <>
          <ul aria-label="Notices" className="space-y-3">
            {result.items.map((n) => (
              <li key={n.id}>
                <NoticeCard notice={n} />
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-2">
              <button
                type="button"
                className={pageButton}
                disabled={page <= 1}
                onClick={() => setParams(page - 1 > 1 ? { page: String(page - 1) } : {})}
              >
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Page {page} of {pages}
              </span>
              <button
                type="button"
                className={pageButton}
                disabled={page >= pages}
                onClick={() => setParams({ page: String(page + 1) })}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

// The top of the student's home (section 9: "urgent and pinned notices" come first):
// only the urgent and pinned ones, from the first page of notices, which starts with
// every pinned one. Nothing at all when there are none, or when they cannot be loaded
// (the complaints below are the page's main content).
export function ImportantNotices() {
  const [notices, setNotices] = useState<Announcement[]>([]);

  useEffect(() => {
    let current = true;
    listAnnouncements(1)
      .then((r) => current && setNotices(r.items.filter((n) => n.isUrgent || n.isPinned)))
      .catch(() => current && setNotices([]));
    return () => {
      current = false;
    };
  }, []);

  if (notices.length === 0) return null;
  return (
    <section aria-labelledby="important-notices" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="important-notices" className="text-sm font-semibold text-slate-700">
          Important notices
        </h2>
        <Link to="/notices" className="text-sm font-medium text-indigo-700 hover:underline">
          See all notices
        </Link>
      </div>
      <ul className="space-y-3">
        {notices.map((n) => (
          <li key={n.id}>
            <NoticeCard notice={n} />
          </li>
        ))}
      </ul>
    </section>
  );
}
