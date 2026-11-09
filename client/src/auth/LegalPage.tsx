import { useEffect } from "react";
import { LEGAL_VERSION, PRIVACY, TERMS, UNDER_REVIEW, type LegalDocument } from "../legal/documents";

// The Terms of Service and the Privacy Policy (multi-tenant phase 4b), for everyone,
// signed in or not. The text lives in src/legal/documents.ts; it is a draft until a
// lawyer has reviewed it, and sign-up (SIGNUPS_OPEN) stays closed until then.
const DOCUMENTS: Record<"terms" | "privacy", LegalDocument> = { terms: TERMS, privacy: PRIVACY };

export function LegalPage({ document: which }: { document: "terms" | "privacy" }) {
  const doc = DOCUMENTS[which];
  const other = which === "terms" ? { href: "/privacy", label: PRIVACY.title } : { href: "/terms", label: TERMS.title };

  useEffect(() => {
    const before = window.document.title;
    window.document.title = `${doc.title} · HostelConnect`;
    return () => {
      window.document.title = before;
    };
  }, [doc.title]);

  return (
    <main className="bg-app min-h-dvh px-4 py-10">
      <article className="glass mx-auto max-w-2xl rounded-[1.75rem] p-6 shadow-[0_24px_50px_-24px_rgb(10_10_15/0.35)] sm:p-8">
        <a href="/" className="font-display text-sm font-extrabold tracking-tight text-muted hover:text-ink">
          HostelConnect
        </a>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight text-ink">{doc.title}</h1>
        <p className="mt-1 text-sm text-muted">Version {LEGAL_VERSION}</p>
        {UNDER_REVIEW && (
          <p role="note" className="hc-pill-amber mt-4 rounded-2xl px-3.5 py-3 text-sm font-medium">
            {UNDER_REVIEW}
          </p>
        )}
        <p className="mt-5 text-base text-ink">{doc.summary}</p>

        {doc.sections.map((section) => (
          <section key={section.heading} className="mt-7">
            <h2 className="font-display text-lg font-extrabold tracking-tight text-ink">{section.heading}</h2>
            {section.blocks.map((block, i) =>
              typeof block === "string" ? (
                <p key={i} className="mt-2 text-sm leading-relaxed text-ink">
                  {block}
                </p>
              ) : (
                <ul key={i} className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink">
                  {block.list.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ),
            )}
          </section>
        ))}

        <nav aria-label="More" className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-5 text-sm font-semibold">
          <a href={other.href} className="inline-flex min-h-11 items-center text-accent hover:underline">
            {other.label}
          </a>
          <a href="/" className="inline-flex min-h-11 items-center text-accent hover:underline">
            Back to HostelConnect
          </a>
        </nav>
      </article>
    </main>
  );
}
