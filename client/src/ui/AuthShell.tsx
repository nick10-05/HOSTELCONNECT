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
        <AboutFooter />
      </div>
    </main>
  );
}

// What HostelConnect is, with the Terms and the Privacy Policy, on every page before
// sign-in: a sign-in page that says none of this is what Google Safe Browsing flags as
// deceptive. Who runs it ("Run by …") and a Contact link (OPERATOR.email) are to join
// once the operator's details are decided (src/legal/operator.ts); no placeholder until then.
function AboutFooter() {
  const link = "inline-flex min-h-11 items-center px-2 font-semibold text-accent hover:underline";
  return (
    <footer className="mt-8 text-center text-xs leading-relaxed text-muted">
      <p>HostelConnect helps hostel owners run their hostel, and their students reach them.</p>
      <nav aria-label="About HostelConnect" className="mt-1 flex justify-center gap-1">
        <a href="/terms" className={link}>
          Terms
        </a>
        <a href="/privacy" className={link}>
          Privacy
        </a>
      </nav>
    </footer>
  );
}

// The card the form sits in: frosted glass over the background's colours.
export const authCardClass = "glass mt-8 space-y-5 rounded-[1.75rem] p-6 shadow-[0_24px_50px_-24px_rgb(10_10_15/0.35)]";
