import { useId, useState } from "react";
import { signOutOtherDevices } from "../api/auth";
import { ApiError } from "../api/client";
import { buttonClass } from "../ui";

// "Sign out of other devices" (security audit): for a lost phone, or a computer someone
// else may still be signed in on. Every other sign-in of the account ends; this one stays,
// and the password does not change. Shown to owners in Settings and to students on home.
export function SignOutOtherDevices({ className = "" }: { className?: string }) {
  const headingId = useId();
  const [step, setStep] = useState<"idle" | "asking" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setError(null);
    setStep("busy");
    try {
      await signOutOtherDevices();
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setStep("asking");
    }
  };

  const cancel = () => {
    setError(null);
    setStep("idle");
  };

  return (
    <section
      aria-labelledby={headingId}
      className={`space-y-3 rounded-card border border-line bg-surface p-4 shadow-card ${className}`}
    >
      <h2 id={headingId} className="font-display text-xl font-extrabold tracking-tight text-ink">
        Your devices
      </h2>
      <p className="text-sm text-muted">
        Lost a phone, or signed in on a shared computer? Sign out everywhere else. You stay signed in here, and your
        password stays the same.
      </p>
      {step === "done" && (
        <p role="status" className="hc-pill-green rounded-2xl px-3.5 py-3 text-sm font-medium">
          Signed out on every other device.
        </p>
      )}
      {error && (
        <p role="alert" className="hc-pill-red rounded-2xl px-3.5 py-3 text-sm font-medium">
          {error}
        </p>
      )}
      {step === "asking" || step === "busy" ? (
        <div className="space-y-3">
          <p className="text-sm font-medium text-ink">Sign out on every other phone and computer?</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={confirm} disabled={step === "busy"} className={buttonClass("primary")}>
              {step === "busy" ? "Signing out…" : "Yes, sign out others"}
            </button>
            <button type="button" onClick={cancel} disabled={step === "busy"} className={buttonClass("secondary")}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setStep("asking")} className={buttonClass("secondary")}>
          Sign out of other devices
        </button>
      )}
    </section>
  );
}
