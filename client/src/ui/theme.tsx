import { useEffect, useId, useRef, useState } from "react";
import { AutoThemeIcon, MoonIcon, SunIcon } from "./icons";
import { Segmented } from "./ListParts";

// Light or dark mode. "system" follows the phone's own setting (the default); "light" and
// "dark" are the person's own choice, kept on this device only (never sent to the server).
// index.html applies a saved choice before the page first paints, so there is no flash.

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "hc-theme";
const BAR_COLOUR = { light: "#fafafb", dark: "#09090c" } as const;

export function readThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system"; // storage blocked (private mode): just follow the phone
  }
}

export function saveThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not saved, but the page still switches for this visit.
  }
}

// Marks <html> with data-theme, which the stylesheet obeys over the phone's setting, and
// colours the phone's browser bar to match.
export function applyThemeChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.default ??= meta.content;
    meta.content = choice === "system" ? meta.dataset.default : BAR_COLOUR[choice];
  }
}

const options = [
  ["system", "Automatic"],
  ["light", "Light"],
  ["dark", "Dark"],
] as const;
const names: Record<ThemeChoice, string> = { system: "Automatic", light: "Light", dark: "Dark" };
const icons = { system: AutoThemeIcon, light: SunIcon, dark: MoonIcon };

// The button in the top bar, with a small panel to pick Automatic, Light or Dark.
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  function pick(next: ThemeChoice) {
    setChoice(next);
    saveThemeChoice(next);
    applyThemeChoice(next);
  }

  const Icon = icons[choice];
  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-label={`Appearance: ${names[choice]}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="press flex size-11 items-center justify-center rounded-[15px] border border-line bg-surface text-ink shadow-card hover:bg-soft"
      >
        <Icon size={20} />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-[calc(100%+0.75rem)] z-40 w-72 animate-[fade-in_0.15s_ease-out] rounded-card border border-line bg-surface p-3 shadow-card"
        >
          <p className="mb-2 px-1 text-sm font-bold text-ink">Appearance</p>
          <Segmented label="Appearance" options={options} value={choice} onChange={pick} />
          <p className="mt-2 px-1 text-xs text-muted">Automatic follows your phone's light or dark setting.</p>
        </div>
      )}
    </div>
  );
}
