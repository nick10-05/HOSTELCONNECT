import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PaymentSettings } from "../api/settings";
import { jsonResponse, mockFetch } from "../test/fetch";
import { SettingsPage } from "./SettingsPage";

// The preview draws a QR; the real drawing is checked elsewhere (PaymentQr.test.tsx).
vi.mock("qrcode", () => ({ default: { toString: vi.fn(async () => "<svg></svg>") } }));

const saved: PaymentSettings = {
  upiId: "owner@okaxis",
  upiPayeeName: "Sri Lakshmi Hostel",
  qrUrl: "/api/settings/payment/qr?v=1983300600000",
  updatedAt: "2032-11-02T04:30:00.000Z",
};
const empty: PaymentSettings = { upiId: null, upiPayeeName: null, qrUrl: null, updatedAt: null };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

type Sent = Record<string, string | { size: number; bytes: number[] }>;
type Call = { method: string; sent: Sent | null };

// FormData as plain values, with a file as its size and bytes.
async function formValues(body: unknown): Promise<Sent | null> {
  if (!(body instanceof FormData)) return null;
  const out: Sent = {};
  for (const [key, value] of body.entries()) {
    out[key] =
      typeof value === "string"
        ? value
        : { size: value.size, bytes: [...new Uint8Array(await value.arrayBuffer())] };
  }
  return out;
}

function renderPage(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    expect(url).toBe("/api/settings/payment");
    const call = { method: init?.method ?? "GET", sent: await formValues(init?.body) };
    calls.push(call);
    return answer(call);
  });
  const user = userEvent.setup();
  render(<SettingsPage />);
  return { calls, user };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT").map((c) => c.sent);
const later = (s: PaymentSettings, changes: Partial<PaymentSettings>) => ({
  ...s,
  ...changes,
  updatedAt: "2032-11-06T10:00:00.000Z",
});

describe("SettingsPage", () => {
  it("fills in the saved details and shows the uploaded QR", async () => {
    renderPage(() => jsonResponse(200, saved));
    expect(await screen.findByLabelText("UPI ID")).toHaveValue("owner@okaxis");
    expect(screen.getByLabelText("Payee name (optional)")).toHaveValue("Sri Lakshmi Hostel");
    const current = screen.getByRole("region", { name: "QR image" });
    expect(within(current).getByRole("img", { name: "QR code to pay Sri Lakshmi Hostel" })).toHaveAttribute(
      "src",
      saved.qrUrl,
    );
    expect(within(current).getByLabelText("Remove the uploaded image")).not.toBeChecked();
  });

  it("explains what students see before anything is saved", async () => {
    renderPage(() => jsonResponse(200, empty));
    expect(await screen.findByLabelText("UPI ID")).toHaveValue("");
    const current = screen.getByRole("region", { name: "QR image" });
    expect(current).toHaveTextContent("No image uploaded. Students see a QR code drawn from the UPI ID.");
    expect(within(current).queryByLabelText("Remove the uploaded image")).not.toBeInTheDocument();
  });

  it("saves the UPI ID and payee name, trimmed, and says the students were told", async () => {
    const { calls, user } = renderPage((call) =>
      call.method === "PUT" ? jsonResponse(200, later(empty, { upiId: "owner@ybl", upiPayeeName: "Lakshmi Hostel" })) : jsonResponse(200, empty),
    );
    await user.type(await screen.findByLabelText("UPI ID"), " owner@ybl ");
    await user.type(screen.getByLabelText("Payee name (optional)"), "Lakshmi Hostel ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved. Every current student has been notified.");
    expect(puts(calls)).toEqual([{ upiId: "owner@ybl", upiPayeeName: "Lakshmi Hostel" }]);
    expect(screen.getByLabelText("UPI ID")).toHaveValue("owner@ybl");
  });

  it("uploads a chosen QR picture unchanged, and shows the new one", async () => {
    const after = later(saved, { qrUrl: "/api/settings/payment/qr?v=1983600000000" });
    const { calls, user } = renderPage((call) => jsonResponse(200, call.method === "PUT" ? after : saved));
    await user.upload(await screen.findByLabelText("Upload a new QR picture"), new File([PNG], "qr.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("status");
    expect(puts(calls)).toEqual([
      { upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel", qr: { size: PNG.length, bytes: [...PNG] } },
    ]);
    expect(screen.getByRole("img", { name: "QR code to pay Sri Lakshmi Hostel" })).toHaveAttribute("src", after.qrUrl);
  });

  it("removes the uploaded image when asked", async () => {
    const { calls, user } = renderPage((call) =>
      jsonResponse(200, call.method === "PUT" ? later(saved, { qrUrl: null }) : saved),
    );
    await user.click(await screen.findByLabelText("Remove the uploaded image"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(puts(calls)).toEqual([{ upiId: "owner@okaxis", upiPayeeName: "Sri Lakshmi Hostel", removeQr: "true" }]);
    expect(await screen.findByText("No image uploaded. Students see a QR code drawn from the UPI ID.")).toBeInTheDocument();
  });

  it("says so when nothing changed", async () => {
    const { user } = renderPage(() => jsonResponse(200, saved));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nothing changed, so no one was notified.");
  });

  it("holds back a UPI ID that does not look like one, and a long payee name", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, empty));
    const upi = await screen.findByLabelText("UPI ID");
    const save = screen.getByRole("button", { name: "Save" });
    for (const bad of ["owner", "owner@", "own er@okaxis", "a@b@c"]) {
      await user.clear(upi);
      await user.type(upi, bad);
      expect(upi, bad).toHaveAttribute("aria-invalid", "true");
      expect(save, bad).toBeDisabled();
    }
    expect(screen.getByText("Enter a UPI ID such as name@bank.")).toBeInTheDocument();
    // Long values are set at once: typing them key by key is slow.
    fireEvent.change(upi, { target: { value: `${"a".repeat(248)}@okaxis` } }); // 255 characters
    expect(save).toBeEnabled();
    fireEvent.change(upi, { target: { value: `${"a".repeat(249)}@okaxis` } });
    expect(save).toBeDisabled();
    expect(screen.getByText("At most 255 characters.")).toBeInTheDocument();

    await user.clear(upi);
    expect(upi).toHaveAttribute("aria-invalid", "false");
    const name = screen.getByLabelText("Payee name (optional)");
    fireEvent.change(name, { target: { value: "x".repeat(101) } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    expect(puts(calls)).toEqual([]);
  });

  it("shows the server's refusal", async () => {
    const { user } = renderPage((call) =>
      call.method === "PUT"
        ? jsonResponse(400, { error: { code: "payment_details_missing", message: "Add a UPI ID or a QR image." } })
        : jsonResponse(200, empty),
    );
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a UPI ID or a QR image.");
  });

  it("refuses a picture it cannot prepare, without saving", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, saved));
    // Over 200 KB, so it must be shrunk, and this test browser cannot draw pictures.
    const big = new File([new Uint8Array(300 * 1024)], "qr.png", { type: "image/png" });
    await user.upload(await screen.findByLabelText("Upload a new QR picture"), big);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This picture could not be made small enough. Try a screenshot of just the QR code.",
    );
    expect(puts(calls)).toEqual([]);
  });

  it("shows why the details could not be loaded", async () => {
    renderPage(() => jsonResponse(500, { error: { code: "internal", message: "Something broke." } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke.");
  });
});
