import { useState } from "react";
import { secondaryButton } from "./styles";

// A temporary password, shown once with a Copy button, after an admission or a
// reactivation. It lives only in the calling page's memory and is gone when the owner
// moves on; the server never sends it again.
export function TemporaryPassword({ password }: { password: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(password)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <>
      <div>
        <p className="mb-1 text-sm font-medium text-muted">Temporary password</p>
        <div className="flex flex-wrap items-center gap-3">
          <code className="rounded-lg bg-soft px-3 py-2 font-mono text-2xl tracking-widest text-ink">
            {password}
          </code>
          <button type="button" onClick={copy} className={secondaryButton}>
            {copied ? "Copied" : "Copy password"}
          </button>
        </div>
      </div>
      <p className="hc-pill-amber rounded-2xl px-3.5 py-3 text-sm font-medium">
        It is shown only now and cannot be seen again. Give it to the student in person; they
        must choose their own password when they next log in.
      </p>
    </>
  );
}
