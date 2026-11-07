import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircleIcon, CheckIcon, InfoIcon } from "./icons";

// The short message that grows out of the top of the screen, like the iPhone's Dynamic
// Island: "Fee marked paid". It is read out politely (role=status, always on the page so
// screen readers notice new text) and goes away by itself. A newer message replaces it.

export const TOAST_MS = 2600;

type ToastTone = "success" | "info" | "error";
// `available` says whether a provider is there to show it; a page without one (a page
// rendered on its own, as in its tests) shows its message in the page instead.
type ToastApi = { show: (text: string, tone?: ToastTone) => void; available: boolean };

// Outside a provider, show() does nothing, so a page under test needs no wrapper.
const ToastContext = createContext<ToastApi>({ show: () => {}, available: false });

export const useToast = () => useContext(ToastContext);

const toneStyle: Record<ToastTone, { dot: string; Icon: typeof CheckIcon }> = {
  success: { dot: "bg-emerald-500", Icon: CheckIcon },
  info: { dot: "bg-indigo-500", Icon: InfoIcon },
  error: { dot: "bg-rose-600", Icon: AlertCircleIcon },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  // `key` restarts the grow-in animation when a new message replaces the one shown.
  const [toast, setToast] = useState<{ text: string; tone: ToastTone; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((text: string, tone: ToastTone = "success") => {
    clearTimeout(timer.current);
    setToast({ text, tone, key: Date.now() });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const api = useRef<ToastApi>({ show, available: true });
  api.current.show = show;

  return (
    <ToastContext.Provider value={api.current}>
      {children}
      <div
        role="status"
        className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-4"
      >
        {toast && <Island key={toast.key} text={toast.text} tone={toast.tone} />}
      </div>
    </ToastContext.Provider>
  );
}

function Island({ text, tone }: { text: string; tone: ToastTone }) {
  const { dot, Icon } = toneStyle[tone];
  return (
    <div className="flex max-w-full animate-[island_0.55s_cubic-bezier(0.3,1.4,0.5,1)_both] items-center gap-2.5 rounded-full bg-black py-2 pr-4 pl-2 text-sm font-semibold text-white shadow-[0_16px_36px_-10px_rgb(0_0_0/0.6)] ring-1 ring-white/10">
      <span className={`flex size-7 shrink-0 items-center justify-center rounded-full ${dot}`}>
        <Icon size={16} />
      </span>
      <span className="truncate">{text}</span>
    </div>
  );
}
