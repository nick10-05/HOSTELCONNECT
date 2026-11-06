import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PaymentSettings } from "../api/settings";
import { jsonResponse, mockFetch } from "../test/fetch";
import { PaymentDetails, PaymentQr } from "./PaymentQr";

// The real library draws a QR nobody can read back in a test, so this one returns an SVG
// that carries the text it was asked to draw.
vi.mock("qrcode", () => ({
  default: { toString: vi.fn(async (text: string) => `<svg data-text="${text}"></svg>`) },
}));

const drawnText = (img: HTMLElement) => {
  const src = img.getAttribute("src")!;
  expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
  const svg = decodeURIComponent(src.slice("data:image/svg+xml;charset=utf-8,".length));
  return svg.match(/data-text="([^"]*)"/)![1];
};

const upiOnly: PaymentSettings = {
  upiId: "owner@okaxis",
  upiPayeeName: "Sri Lakshmi Hostel",
  qrUrl: null,
  updatedAt: "2032-11-02T04:30:00.000Z",
};
const withImage: PaymentSettings = { ...upiOnly, qrUrl: "/api/settings/payment/qr?v=1983300600000" };

describe("PaymentQr", () => {
  it("shows the uploaded image when there is one", () => {
    render(<PaymentQr settings={withImage} amount={6500} />);
    const img = screen.getByRole("img", { name: "QR code to pay Sri Lakshmi Hostel" });
    expect(img).toHaveAttribute("src", "/api/settings/payment/qr?v=1983300600000");
  });

  it("draws a QR of the UPI link, with the amount, when only the UPI ID is set", async () => {
    render(<PaymentQr settings={upiOnly} amount={6500} />);
    const img = await screen.findByRole("img", { name: "QR code to pay Sri Lakshmi Hostel" });
    expect(drawnText(img)).toBe("upi://pay?pa=owner@okaxis&pn=Sri%20Lakshmi%20Hostel&am=6500.00&cu=INR");
  });

  it("names the UPI ID when there is no payee name", async () => {
    render(<PaymentQr settings={{ ...upiOnly, upiPayeeName: null }} />);
    const img = await screen.findByRole("img", { name: "QR code to pay owner@okaxis" });
    expect(drawnText(img)).toBe("upi://pay?pa=owner@okaxis&cu=INR");
  });

  it("shows nothing without a UPI ID or an image", () => {
    const { container } = render(<PaymentQr settings={{ ...upiOnly, upiId: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

function renderDetails(answer: () => Response, amount?: number) {
  const requested: string[] = [];
  mockFetch(async (url) => {
    requested.push(url);
    return answer();
  });
  const { container } = render(<PaymentDetails amount={amount} />);
  return { requested, container };
}

describe("PaymentDetails", () => {
  it("shows the UPI ID, payee name, QR and a link that opens a UPI app with the amount", async () => {
    const { requested } = renderDetails(() => jsonResponse(200, upiOnly), 6500);
    const box = await screen.findByRole("region", { name: "Pay the hostel" });
    expect(within(box).getByText("owner@okaxis")).toBeInTheDocument();
    expect(box).toHaveTextContent("Sri Lakshmi Hostel");
    expect(await within(box).findByRole("img", { name: "QR code to pay Sri Lakshmi Hostel" })).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: "Pay with a UPI app" })).toHaveAttribute(
      "href",
      "upi://pay?pa=owner@okaxis&pn=Sri%20Lakshmi%20Hostel&am=6500.00&cu=INR",
    );
    expect(box).toHaveTextContent("The hostel records your payment, and it shows here once recorded.");
    expect(requested).toEqual(["/api/settings/payment"]);
  });

  it("shows only the uploaded QR when there is no UPI ID", async () => {
    renderDetails(() => jsonResponse(200, { ...withImage, upiId: null, upiPayeeName: null }));
    const box = await screen.findByRole("region", { name: "Pay the hostel" });
    expect(within(box).getByRole("img", { name: "QR code to pay the hostel" })).toBeInTheDocument();
    expect(within(box).queryByRole("link", { name: "Pay with a UPI app" })).not.toBeInTheDocument();
    expect(box).not.toHaveTextContent("UPI ID");
  });

  it("says when the hostel has not added payment details", async () => {
    renderDetails(() => jsonResponse(200, { upiId: null, upiPayeeName: null, qrUrl: null, updatedAt: null }));
    const box = await screen.findByRole("region", { name: "Pay the hostel" });
    expect(box).toHaveTextContent("The hostel has not added payment details yet.");
  });

  it("shows nothing when the details cannot be loaded", async () => {
    const { container } = renderDetails(() => jsonResponse(500, { error: { code: "internal", message: "Down." } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
