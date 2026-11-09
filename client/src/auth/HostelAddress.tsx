import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { ApiError } from "../api/client";
import { getHostel, type Hostel } from "../api/hostels";
import { AuthShell, authCardClass } from "../ui/AuthShell";

// The pages under a hostel's address, /h/<slug>/… (multi-tenant phase 3a): finds the
// hostel the address belongs to, then shows the page for it. The hostel comes from the
// address only, so a student's link always leads to their own hostel.
type State = { status: "loading" } | { status: "found"; hostel: Hostel } | { status: "missing" } | { status: "error" };

export function HostelAddress({ children }: { children: (hostel: Hostel) => ReactNode }) {
  const { slug = "" } = useParams();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    getHostel(slug)
      .then((hostel) => current && setState({ status: "found", hostel }))
      .catch((err: unknown) => {
        if (!current) return;
        setState(err instanceof ApiError && err.status === 404 ? { status: "missing" } : { status: "error" });
      });
    return () => {
      current = false;
    };
  }, [slug]);

  if (state.status === "found") return <>{children(state.hostel)}</>;
  if (state.status === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-app text-sm text-muted" role="status">
        Loading…
      </main>
    );
  }
  return (
    <AuthShell
      title={state.status === "missing" ? "No hostel here" : "Something went wrong"}
      subtitle={
        state.status === "missing"
          ? "No hostel uses this address. Check the link your hostel gave you."
          : "The hostel could not be loaded. Please try again."
      }
    >
      <div className={`${authCardClass} text-center text-sm text-muted`}>
        {state.status === "missing"
          ? "Your hostel's owner can tell you its sign-in address."
          : "If the server was asleep, it can take up to a minute to wake."}
      </div>
    </AuthShell>
  );
}
