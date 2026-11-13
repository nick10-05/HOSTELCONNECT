import { useEffect } from "react";
import { buttonClass } from "../ui";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// An address the app has no page for (src/appPages.ts), signed out: say so, instead of a
// sign-in form at any made-up address, which Google Safe Browsing reads as phishing. The
// server answers these addresses with 404.
export function NotFoundPage() {
  useEffect(() => {
    const before = document.title;
    document.title = "Page not found · HostelConnect";
    return () => {
      document.title = before;
    };
  }, []);

  return (
    <AuthShell title="Page not found" subtitle="HostelConnect has no page at this address.">
      <div className={authCardClass}>
        <p className="text-sm text-ink">
          Check the link you were given. To sign in, start from your hostel's own sign-in page, or from the sign-in page
          below.
        </p>
        <a href="/login" className={`${buttonClass("primary")} min-h-12 w-full`}>
          Go to sign in
        </a>
      </div>
    </AuthShell>
  );
}
