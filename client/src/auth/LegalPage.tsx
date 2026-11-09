import { AuthShell, authCardClass } from "../ui/AuthShell";

// The Terms of Service and the Privacy Policy (multi-tenant phase 4a). Placeholders: the
// plain-language drafts come in phase 4b, and a lawyer reviews them before sign-up opens
// (SIGNUPS_OPEN stays off until then).
const TITLES = { terms: "Terms of Service", privacy: "Privacy Policy" } as const;

export function LegalPage({ document }: { document: keyof typeof TITLES }) {
  return (
    <AuthShell title={TITLES[document]}>
      <div className={authCardClass}>
        <p role="status" className="hc-pill-amber rounded-2xl px-3.5 py-3 text-sm font-medium">
          This document is being written and reviewed. It will be here before new hostels can sign up.
        </p>
        <a href="/" className="block text-center text-sm font-semibold text-accent hover:underline">
          Back to HostelConnect
        </a>
      </div>
    </AuthShell>
  );
}
