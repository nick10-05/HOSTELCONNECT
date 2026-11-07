import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";
import { TOAST_MS, ToastProvider, useToast } from "./Toast";

function SheetHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        More
      </button>
      <BottomSheet
        open={open}
        title="More pages"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      >
        <a href="/structure">Buildings</a>
      </BottomSheet>
    </>
  );
}

describe("BottomSheet", () => {
  it("is not there until opened, then is a named dialog with the focus inside", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More pages" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
  });

  it("closes with Escape and gives the focus back to the button that opened it", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    const more = screen.getByRole("button", { name: "More" });
    await user.click(more);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it("closes with its Close button and with a tap on the dimmed page behind it", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SheetHarness onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByTestId("sheet-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside the sheet", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog");
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
    }
    await user.tab({ shift: true });
    expect(sheet).toContainElement(document.activeElement as HTMLElement);
  });
});

function ToastButton({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(text)}>
      Show {text}
    </button>
  );
}

describe("Toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a message at the top for a few seconds, read out politely", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastButton text="Fee marked paid" />
      </ToastProvider>,
    );
    const live = screen.getByRole("status");
    expect(live).toBeEmptyDOMElement();

    act(() => screen.getByRole("button", { name: "Show Fee marked paid" }).click());
    expect(live).toHaveTextContent("Fee marked paid");

    act(() => vi.advanceTimersByTime(TOAST_MS + 50));
    expect(live).toBeEmptyDOMElement();
  });

  it("replaces the message shown with a newer one and starts the timer again", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastButton text="First" />
        <ToastButton text="Second" />
      </ToastProvider>,
    );
    act(() => screen.getByRole("button", { name: "Show First" }).click());
    act(() => vi.advanceTimersByTime(TOAST_MS - 500));
    act(() => screen.getByRole("button", { name: "Show Second" }).click());
    expect(screen.getByRole("status")).toHaveTextContent("Second");
    expect(screen.getByRole("status")).not.toHaveTextContent("First");

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent("Second");
  });

  it("does nothing when used outside the provider, instead of crashing a page", () => {
    render(<ToastButton text="Lonely" />);
    act(() => screen.getByRole("button", { name: "Show Lonely" }).click());
    expect(screen.queryByText("Lonely", { selector: "[role=status] *" })).not.toBeInTheDocument();
  });

  it("tells a page whether a provider is there to show its message", () => {
    let seen: boolean[] = [];
    function Probe() {
      seen.push(useToast().available);
      return null;
    }
    render(<Probe />);
    expect(seen.at(-1)).toBe(false);
    seen = [];
    render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    expect(seen.at(-1)).toBe(true);
  });
});
