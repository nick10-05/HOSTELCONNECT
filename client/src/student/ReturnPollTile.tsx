import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { answerPoll, listMyOpenPolls, type MyOpenPoll, type PollResponse } from "../api/returnPolls";
import { formatTime } from "../components/complaintText";
import { Alert } from "../ui";
import { CheckIcon, ReturnIcon } from "../ui/icons";

// The open return poll on the student's home (design doc, section 9: "an open return poll
// with two buttons"; day 9). The student answers, and may change the answer while the poll
// is open. Nothing at all when no poll is open, or when it cannot be loaded (the rest of
// the home page matters more than an error here). A poll's notification links here.

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const ANSWERS: [PollResponse, string][] = [
  ["returned", "I'm back"],
  ["not_yet", "Not yet"],
];
const answerLabel = (r: PollResponse) => ANSWERS.find(([value]) => value === r)![1];

export function ReturnPollTile() {
  const [polls, setPolls] = useState<MyOpenPoll[]>([]);

  useEffect(() => {
    let current = true;
    listMyOpenPolls()
      .then((p) => current && setPolls(p))
      .catch(() => current && setPolls([]));
    return () => {
      current = false;
    };
  }, []);

  if (polls.length === 0) return null;
  return (
    <div className="space-y-3">
      {polls.map((p) => (
        <PollCard key={p.id} poll={p} />
      ))}
    </div>
  );
}

function PollCard({ poll }: { poll: MyOpenPoll }) {
  const [answer, setAnswer] = useState({ response: poll.myResponse, respondedAt: poll.respondedAt });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = `return-poll-${poll.id}`;

  const send = async (response: PollResponse) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await answerPoll(poll.id, response);
      setAnswer({ response: saved.response, respondedAt: saved.respondedAt });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // The poll is the one thing on the home page that asks something: the gradient card.
  return (
    <section
      aria-labelledby={headingId}
      className="rise bg-hero relative space-y-4 overflow-hidden rounded-[1.75rem] p-5 shadow-[var(--hc-hero-shadow)]"
    >
      <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/15 blur-2xl" />
      <div className="relative flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-[var(--hc-chip-line)] bg-[var(--hc-chip)] text-hero-ink"
        >
          <ReturnIcon />
        </span>
        <div className="min-w-0">
          <h2 id={headingId} className="font-display text-lg font-extrabold break-words text-hero-ink">
            {poll.title}
          </h2>
          <p className="text-sm text-hero-muted">Let the hostel know whether you are back.</p>
        </div>
      </div>
      <div className="relative flex gap-2">
        {ANSWERS.map(([value, label]) => {
          const chosen = answer.response === value;
          return (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={chosen}
              onClick={() => void send(value)}
              className={`press inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-bold disabled:opacity-60 ${
                chosen
                  ? "bg-strong text-strong-ink shadow-[0_10px_24px_-12px_rgb(0_0_0/0.6)]"
                  : "border border-[var(--hc-chip-line)] bg-[var(--hc-chip)] text-hero-ink"
              }`}
            >
              {chosen && <CheckIcon size={18} />}
              {label}
            </button>
          );
        })}
      </div>
      {answer.response && answer.respondedAt && (
        <p className="relative text-sm text-hero-muted">
          Your answer: {answerLabel(answer.response)} ({formatTime(answer.respondedAt)}). You can change it while the
          poll is open.
        </p>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </section>
  );
}
