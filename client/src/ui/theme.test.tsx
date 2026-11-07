import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyThemeChoice, readThemeChoice, saveThemeChoice, ThemeSwitch } from "./theme";

function addThemeMetas() {
  document.head.innerHTML = `
    <meta name="theme-color" content="#fafafb" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#09090c" media="(prefers-color-scheme: dark)" />`;
}
const metaContents = () =>
  [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  addThemeMetas();
});
afterEach(() => {
  document.head.innerHTML = "";
});

describe("the saved appearance", () => {
  it("is automatic until the person picks one", () => {
    expect(readThemeChoice()).toBe("system");
  });

  it("remembers light or dark", () => {
    saveThemeChoice("dark");
    expect(readThemeChoice()).toBe("dark");
    saveThemeChoice("light");
    expect(readThemeChoice()).toBe("light");
  });

  it("forgets the choice when set back to automatic", () => {
    saveThemeChoice("dark");
    saveThemeChoice("system");
    expect(readThemeChoice()).toBe("system");
    expect(localStorage.getItem("hc-theme")).toBeNull();
  });

  it("ignores anything else found in storage", () => {
    localStorage.setItem("hc-theme", "purple");
    expect(readThemeChoice()).toBe("system");
  });
});

describe("applying the appearance", () => {
  it("marks the page light or dark, and follows the phone again on automatic", () => {
    applyThemeChoice("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyThemeChoice("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyThemeChoice("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("colours the phone's browser bar to match, and restores it on automatic", () => {
    applyThemeChoice("dark");
    expect(metaContents()).toEqual(["#09090c", "#09090c"]);
    applyThemeChoice("light");
    expect(metaContents()).toEqual(["#fafafb", "#fafafb"]);
    applyThemeChoice("system");
    expect(metaContents()).toEqual(["#fafafb", "#09090c"]);
  });
});

describe("ThemeSwitch", () => {
  it("offers automatic, light and dark, with automatic chosen at first", async () => {
    render(<ThemeSwitch />);
    const button = screen.getByRole("button", { name: "Appearance: Automatic" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
  });

  it("switches the page to dark and remembers it", async () => {
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole("button", { name: "Appearance: Automatic" }));
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(readThemeChoice()).toBe("dark");
    expect(screen.getByRole("button", { name: "Appearance: Dark" })).toBeInTheDocument();
  });

  it("starts from the saved choice", () => {
    saveThemeChoice("light");
    render(<ThemeSwitch />);
    expect(screen.getByRole("button", { name: "Appearance: Light" })).toBeInTheDocument();
  });

  it("closes with Escape and gives focus back to the button", async () => {
    render(<ThemeSwitch />);
    const button = screen.getByRole("button", { name: "Appearance: Automatic" });
    await userEvent.click(button);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("radio", { name: "Dark" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("closes when the person taps outside it", async () => {
    render(
      <>
        <ThemeSwitch />
        <p>Elsewhere</p>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Appearance: Automatic" }));
    await userEvent.click(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("radio", { name: "Dark" })).not.toBeInTheDocument();
  });
});
