import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

// A menu that slides up from the bottom, like iPhone and Samsung sheets. While it is
// open it is a modal dialog: the page behind is dimmed and does not scroll, Tab stays
// inside, and Escape, the Close button or a tap on the dimmed page close it. The focus
// goes back to whatever opened it.

type Props = { open: boolean; title: string; onClose: () => void; children: ReactNode };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BottomSheet({ open, title, onClose, children }: Props) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Kept in a ref, so a new onClose on every render does not re-run the effect below.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div
        data-testid="sheet-backdrop"
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 animate-[fade-in_0.3s_both] bg-[var(--hc-scrim)] backdrop-blur-[3px]"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass absolute inset-x-2 bottom-2 mx-auto max-h-[85dvh] max-w-lg animate-[sheet-up_0.45s_cubic-bezier(0.2,0.9,0.25,1)_both] overflow-y-auto rounded-[2rem] px-5 pt-2.5 pb-6 shadow-[0_-10px_40px_-10px_rgb(0_0_0/0.35)]"
      >
        <div aria-hidden="true" className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-faint/50" />
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-xl font-extrabold text-ink">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="press flex size-9 items-center justify-center rounded-full bg-soft text-ink"
          >
            <CloseIcon size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
