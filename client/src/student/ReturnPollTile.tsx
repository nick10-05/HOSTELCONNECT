import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { answerPoll, listMyOpenPolls, type MyOpenPoll, type PollResponse } from "../api/returnPolls";
import { formatTime } from "../components/complaintText";

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

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 shadow-sm"
    >
      <div>
        <h2 id={headingId} className="font-semibold text-slate-900">
          {poll.title}
        </h2>
        <p className="text-sm text-slate-600">Let the hostel know whether you are back.</p>
      </div>
      <div className="flex gap-2">
        {ANSWERS.map(([value, label]) => {
          const chosen = answer.response === value;
          return (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={chosen}
              onClick={() => void send(value)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60 ${
                chosen
                  ? "bg-indigo-600 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {answer.response && answer.respondedAt && (
        <p className="text-sm text-slate-600">
          Your answer: {answerLabel(answer.response)} ({formatTime(answer.respondedAt)}). You can change it while the
          poll is open.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
