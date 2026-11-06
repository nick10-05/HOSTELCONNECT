import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MyFeeRow, MyFees } from "../api/fees";
import { jsonResponse, mockFetch } from "../test/fetch";
import { MyFeesCard, MyFeesPage } from "./MyFeesPage";

const fee = (r: Partial<MyFeeRow>): MyFeeRow => ({
  id: 1,
  dueDate: "2032-07-14",
  amount: 6500,
  status: "pending",
  paidOn: null,
  note: null,
  ...r,
});

const june = fee({ id: 1, dueDate: "2032-06-14", status: "paid", paidOn: "2032-06-15", note: "By UPI" });
const july = fee({ id: 2, dueDate: "2032-07-14" });
const today = fee({ id: 3, dueDate: "2032-08-01", amount: null });
const august = fee({ id: 4, dueDate: "2032-08-05" });

const mine: MyFees = {
  pendingBalance: 6500,
  amountNotSet: 1,
  overdue: [july],
  upcoming: [august],
  history: [august, today, july, june],
  nextDueDate: "2032-08-05",
};
const nothingDue: MyFees = { pendingBalance: 0, amountNotSet: 0, overdue: [], upcoming: [], history: [], nextDueDate: "2032-08-05" };

function renderWith(element: React.ReactElement, answer: () => Response) {
  const requested: string[] = [];
  mockFetch(async (url) => {
    requested.push(url);
    return answer();
  });
  const { container } = render(<MemoryRouter>{element}</MemoryRouter>);
  return { requested, container };
}

describe("MyFeesPage", () => {
  it("shows the balance due now, the next due date, and every fee with its state", async () => {
    const { requested } = renderWith(<MyFeesPage />, () => jsonResponse(200, mine));

    const balance = await screen.findByRole("region", { name: "To pay now" });
    expect(balance).toHaveTextContent("₹6,500");
    expect(balance).toHaveTextContent("1 fee is overdue.");
    expect(balance).toHaveTextContent("1 fee has no amount set yet. Ask the hostel.");
    expect(balance).toHaveTextContent("Next due date: 5 Aug 2032");
    expect(requested).toEqual(["/api/fees/mine"]);

    const items = within(screen.getByRole("list", { name: "My fees" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Due 5 Aug 2032.*₹6,500.*Upcoming$/),
      expect.stringMatching(/^Due 1 Aug 2032.*Amount not set.*Due today$/),
      expect.stringMatching(/^Due 14 Jul 2032.*₹6,500.*Overdue$/),
      expect.stringMatching(/^Due 14 Jun 2032.*Paid on 15 Jun 2032 · By UPI.*₹6,500.*Paid$/),
    ]);
  });

  it("says when nothing is due and there are no fees yet", async () => {
    renderWith(<MyFeesPage />, () => jsonResponse(200, nothingDue));
    const balance = await screen.findByRole("region", { name: "To pay now" });
    expect(balance).toHaveTextContent("Nothing to pay right now.");
    expect(balance).not.toHaveTextContent("overdue");
    expect(screen.getByText("No fees yet.")).toBeInTheDocument();
  });

  it("shows ₹0, not 'nothing to pay', when the only fee due has no amount", async () => {
    renderWith(<MyFeesPage />, () =>
      jsonResponse(200, { ...nothingDue, amountNotSet: 1, history: [today], upcoming: [] }),
    );
    const balance = await screen.findByRole("region", { name: "To pay now" });
    expect(balance).toHaveTextContent("₹0");
    expect(balance).toHaveTextContent("1 fee has no amount set yet. Ask the hostel.");
    expect(balance).not.toHaveTextContent("Nothing to pay right now.");
  });

  it("shows why the fees could not be loaded", async () => {
    renderWith(<MyFeesPage />, () => jsonResponse(500, { error: { code: "internal", message: "Something broke." } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke.");
  });
});

describe("MyFeesCard", () => {
  it("shows the balance, what is overdue and the next due date, with a link to the fees", async () => {
    renderWith(<MyFeesCard />, () => jsonResponse(200, { ...mine, overdue: [july, fee({ id: 9, dueDate: "2032-06-30" })] }));
    const card = await screen.findByRole("region", { name: "My fees" });
    expect(card).toHaveTextContent("To pay now₹6,500");
    expect(card).toHaveTextContent("2 fees are overdue.");
    expect(card).toHaveTextContent("Next due date: 5 Aug 2032");
    expect(within(card).getByRole("link", { name: "See my fees" })).toHaveAttribute("href", "/fees");
  });

  it("says when nothing is due", async () => {
    renderWith(<MyFeesCard />, () => jsonResponse(200, nothingDue));
    expect(await screen.findByRole("region", { name: "My fees" })).toHaveTextContent("Nothing to pay right now.");
  });

  it("shows nothing when the fees cannot be loaded", async () => {
    const { container } = renderWith(<MyFeesCard />, () => jsonResponse(500, { error: { code: "internal", message: "Down." } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
