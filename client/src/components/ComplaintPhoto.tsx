import { useEffect, useState } from "react";
import type { OwnerPhoto, StudentPhoto } from "../api/complaints";

// A complaint's photo on its detail page (design doc, sections 4 and 9; day 8). The link
// from the server works for about a minute, long enough for the picture to load once; it
// is never stored. With `countdown` (the owner's page) it also counts down to the photo's
// deletion, 48 hours after the complaint was raised, and hides it when the time is up.
// The student gets no countdown (decided on day 8).

const DELETED = "The photo has been deleted. Photos are kept for 48 hours.";

// Time left until `expiresAt` (ISO): "47 h 59 min", "59 min", "under a minute"; null once
// it has passed. Whole minutes, rounded down.
export function timeLeftText(expiresAt: string, now = Date.now()): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function ComplaintPhoto({ photo, countdown = false }: { photo: StudentPhoto | OwnerPhoto | null; countdown?: boolean }) {
  const expiresAt = photo && "expiresAt" in photo ? photo.expiresAt : null;
  const [now, setNow] = useState(() => Date.now());
  const [broken, setBroken] = useState(false);

  // The countdown shows whole minutes; ticking twice a minute keeps it at most 30 s late.
  useEffect(() => {
    if (!countdown || !expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [countdown, expiresAt]);

  // A new answer from the server (after the owner's change) brings a fresh link.
  const url = photo?.status === "available" ? photo.url : null;
  useEffect(() => setBroken(false), [url]);

  if (!photo) return null;

  const left = countdown && expiresAt ? timeLeftText(expiresAt, now) : null;
  const expired = photo.status === "expired" || (countdown && expiresAt !== null && left === null);

  return (
    <section aria-labelledby="complaint-photo-heading" className="space-y-2">
      <h2 id="complaint-photo-heading" className="text-base font-bold text-ink">
        Photo
      </h2>
      {expired ? (
        <p className="text-sm text-muted">{DELETED}</p>
      ) : (
        <>
          {photo.status === "unavailable" ? (
            <p className="text-sm text-muted">The photo cannot be shown right now. Try again later.</p>
          ) : broken ? (
            <p className="text-sm text-muted">The photo link has run out. Reload the page to see it again.</p>
          ) : (
            url && (
              <img
                src={url}
                alt="Photo sent with the complaint"
                onError={() => setBroken(true)}
                // A signed link: no Referer to other sites, which would carry it along.
                referrerPolicy="no-referrer"
                className="max-h-96 w-auto max-w-full rounded-lg border border-line"
              />
            )
          )}
          {left && <p className="text-sm text-warn">Deleted in {left}</p>}
        </>
      )}
    </section>
  );
}
