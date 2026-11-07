import type { ReactNode } from "react";

// The frame of the pages before the app (sign in, request access, choose a password): the
// Aurora background, the logo, a big title and the page's card.
export function AuthShell({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="bg-app flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="rise w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="bg-active flex size-14 items-center justify-center rounded-[1.25rem] font-display text-2xl font-extrabold"
          >
            H
          </span>
          <p className="mt-3 font-display text-sm font-extrabold tracking-tight text-muted">HostelConnect</p>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

// The card the form sits in: frosted glass over the background's colours.
export const authCardClass = "glass mt-8 space-y-5 rounded-[1.75rem] p-6 shadow-[0_24px_50px_-24px_rgb(10_10_15/0.35)]";
