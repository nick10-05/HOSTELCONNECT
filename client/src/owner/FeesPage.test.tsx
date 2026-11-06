import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { FeeList, OwnerFeeRow } from "../api/fees";
import { jsonResponse, mockFetch } from "../test/fetch";
import { FeesPage } from "./FeesPage";

const row = (r: Partial<OwnerFeeRow>): OwnerFeeRow => ({
  id: 1,
  studentId: 7,
  studentName: "Asha Rao",
  isActive: true,
  buildingId: 1,
  buildingName: "Block A",
  dueDate: "2032-07-14",
  amount: 6500,
  status: "pending",
  state: "overdue",
  paidOn: null,
  note: null,
  ...r,
});

const overdue = row({});
const paid = row({ id: 2, studentId: 8, studentName: "Bina Das", status: "paid", state: "paid", paidOn: "2032-07-15", note: "By UPI" });
const notSet = row({ id: 3, studentId: 9, studentName: "Chitra K", amount: null, state: "due", dueDate: "2032-07-20" });
const movedOut = row({ id: 4, studentId: 10, studentName: "Divya M", isActive: false, buildingId: null, buildingName: null, state: "upcoming", dueDate: "2032-07-28" });

const july: FeeList = {
  items: [overdue, paid, notSet, movedOut],
  total: 4,
  totals: {
    paid: { count: 1, amount: 6500 },
    pending: { count: 3, amount: 13000 },
    overdue: { count: 1, amount: 6500 },
    amountNotSet: 1,
  },
};
const buildings = [
  { id: 1, name: "Block A", floors: [], rooms: [] },
  { id: 2, name: "Block B", floors: [], rooms: [] },
];

function Address() {
  const location = useLocation();
  return <p data-testid="address">{location.pathname + location.search}</p>;
}

type Call = { url: string; method: string; body: unknown };

function renderPage(answer: (call: Call) => Response, at = "/fees") {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/structure") return jsonResponse(200, { buildings });
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/fees" element={<FeesPage />} />
      </Routes>
      <Address />
    </MemoryRouter>,
  );
  return { calls, user };
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest("li")!;
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

describe("FeesPage", () => {
  it("shows this month's totals and fees, each with its state", async () => {
    const { calls } = renderPage(() => jsonResponse(200, july));

    const totals = await screen.findByRole("region", { name: "Totals" });
    expect(within(totals).getByText("Paid").parentElement).toHaveTextContent(/^Paid₹6,5001 fee$/);
    expect(within(totals).getByText("Pending").parentElement).toHaveTextContent(/^Pending₹13,0003 fees$/);
    expect(within(totals).getByText("Overdue").parentElement).toHaveTextContent(/^Overdue₹6,5001 fee$/);
    expect(totals).toHaveTextContent("1 pending fee has no amount set.");
    expect(calls.map((c) => c.url)).toEqual(["/api/fees?page=1"]);

    expect(await rowOf("Asha Rao")).toHaveTextContent("Block A");
    expect(await rowOf("Asha Rao")).toHaveTextContent("Due 14 Jul 2032");
    expect(await rowOf("Asha Rao")).toHaveTextContent("₹6,500");
    expect(await rowOf("Asha Rao")).toHaveTextContent("Overdue");
    expect(await rowOf("Bina Das")).toHaveTextContent("Paid on 15 Jul 2032 · By UPI");
    expect(await rowOf("Chitra K")).toHaveTextContent("Amount not set");
    expect(await rowOf("Chitra K")).toHaveTextContent("Due today");
    expect(await rowOf("Divya M")).toHaveTextContent("Moved out");
    expect(await rowOf("Divya M")).toHaveTextContent("Upcoming");
    expect(within(await rowOf("Asha Rao")).getByRole("link", { name: "Asha Rao" })).toHaveAttribute("href", "/students/7");
  });

  it("says when the month has no fees", async () => {
    renderPage(() =>
      jsonResponse(200, {
        items: [],
        total: 0,
        totals: { paid: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, amountNotSet: 0 },
      }),
    );
    expect(await screen.findByText("No fees match.")).toBeInTheDocument();
    expect(screen.queryByText(/no amount set/)).not.toBeInTheDocument();
  });

  it("filters by month, state and building, and keeps them in the address", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, july));
    await rowOf("Asha Rao");

    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2032-06" } });
    expect(await screen.findByTestId("address")).toHaveTextContent("/fees?month=2032-06");
    await user.selectOptions(screen.getByLabelText("Show"), "Overdue");
    expect(await screen.findByTestId("address")).toHaveTextContent("/fees?month=2032-06&status=overdue");
    await user.selectOptions(await screen.findByLabelText("Building"), "Block B");
    expect(await screen.findByTestId("address")).toHaveTextContent("/fees?month=2032-06&status=overdue&building=2");

    expect(calls.map((c) => c.url)).toContain("/api/fees?month=2032-06&status=overdue&buildingId=2&page=1");
    await user.click(screen.getByRole("button", { name: "This month" }));
    expect(await screen.findByTestId("address")).toHaveTextContent(/^\/fees\?status=overdue&building=2$/);
  });

  it("opens with the filters from the address", async () => {
    const { calls } = renderPage(() => jsonResponse(200, july), "/fees?month=2032-05&status=paid&building=1");
    await rowOf("Asha Rao");
    expect(calls[0].url).toBe("/api/fees?month=2032-05&status=paid&buildingId=1&page=1");
    expect(screen.getByLabelText("Month")).toHaveValue("2032-05");
    expect(screen.getByLabelText("Show")).toHaveValue("paid");
  });

  it("ignores a state in the address that is not one of the three", async () => {
    const { calls } = renderPage(() => jsonResponse(200, july), "/fees?status=late");
    await rowOf("Asha Rao");
    expect(calls[0].url).toBe("/api/fees?page=1");
    expect(screen.getByLabelText("Show")).toHaveValue("");
  });

  it("does not claim a student who moved out was notified", async () => {
    const { user } = renderPage((call) =>
      call.method === "POST" ? jsonResponse(200, { ...movedOut, status: "paid", paidOn: "2032-08-01" }) : jsonResponse(200, july),
    );
    await user.click(within(await rowOf("Divya M")).getByRole("button", { name: "Mark paid" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/^Marked paid\.$/);
  });

  it("marks a fee paid today with a note, says the student was told, and reloads", async () => {
    let marked = false;
    const { calls, user } = renderPage((call) => {
      if (call.method === "POST") {
        marked = true;
        return jsonResponse(200, { ...overdue, status: "paid", paidOn: "2032-08-01", note: "Cash" });
      }
      return jsonResponse(200, marked ? { ...july, items: [{ ...overdue, status: "paid", state: "paid", paidOn: "2032-08-01", note: "Cash" }] } : july);
    });
    await user.click(within(await rowOf("Asha Rao")).getByRole("button", { name: "Mark paid" }));
    const form = screen.getByRole("form", { name: "Mark paid: Asha Rao" });
    expect(within(form).getByLabelText("Paid on")).toHaveValue("");
    expect(form).toHaveTextContent("Leave the date empty for today.");
    await user.type(within(form).getByLabelText("Note (optional)"), "  Cash ");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Marked paid. Asha Rao has been notified.");
    expect(posts(calls)).toEqual([{ url: "/api/fees/1/status", method: "POST", body: { status: "paid", note: "Cash" } }]);
    expect(await rowOf("Asha Rao")).toHaveTextContent("Paid on 1 Aug 2032 · Cash");
    expect(screen.queryByRole("form", { name: "Mark paid: Asha Rao" })).not.toBeInTheDocument();
  });

  it("sends the payment date when one is given", async () => {
    const { calls, user } = renderPage((call) =>
      call.method === "POST" ? jsonResponse(200, { ...overdue, status: "paid", paidOn: "2032-07-30" }) : jsonResponse(200, july),
    );
    await user.click(within(await rowOf("Asha Rao")).getByRole("button", { name: "Mark paid" }));
    const form = screen.getByRole("form", { name: "Mark paid: Asha Rao" });
    fireEvent.change(within(form).getByLabelText("Paid on"), { target: { value: "2032-07-30" } });
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(posts(calls)[0].body).toEqual({ status: "paid", paidOn: "2032-07-30" });
  });

  it("holds back a note over 200 characters, and can cancel", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, july));
    await user.click(within(await rowOf("Asha Rao")).getByRole("button", { name: "Mark paid" }));
    const form = screen.getByRole("form", { name: "Mark paid: Asha Rao" });
    const note = within(form).getByLabelText("Note (optional)");
    fireEvent.change(note, { target: { value: "x".repeat(201) } });
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(form).getByText("201 / 200")).toBeInTheDocument();
    expect(note).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(note, { target: { value: "💸".repeat(200) } });
    expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Mark paid: Asha Rao" })).not.toBeInTheDocument();
    expect(posts(calls)).toEqual([]);
  });

  it("shows the server's refusal and keeps the form", async () => {
    const { user } = renderPage((call) =>
      call.method === "POST"
        ? jsonResponse(400, { error: { code: "paid_on_in_future", message: "The payment date cannot be after today." } })
        : jsonResponse(200, july),
    );
    await user.click(within(await rowOf("Asha Rao")).getByRole("button", { name: "Mark paid" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The payment date cannot be after today.");
    expect(screen.getByRole("form", { name: "Mark paid: Asha Rao" })).toBeInTheDocument();
  });

  it("marks a paid fee not paid after asking, without notifying", async () => {
    const { calls, user } = renderPage((call) =>
      call.method === "POST" ? jsonResponse(200, { ...paid, status: "pending", paidOn: null, note: null }) : jsonResponse(200, july),
    );
    const bina = await rowOf("Bina Das");
    expect(within(bina).queryByRole("button", { name: "Mark paid" })).not.toBeInTheDocument();
    await user.click(within(bina).getByRole("button", { name: "Mark not paid" }));
    const confirm = within(bina).getByRole("group", { name: "Confirm not paid" });
    expect(confirm).toHaveTextContent("The payment date and note are cleared. Bina Das is not notified.");
    expect(posts(calls)).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Yes, mark not paid" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Marked not paid.");
    expect(posts(calls)).toEqual([{ url: "/api/fees/2/status", method: "POST", body: { status: "pending" } }]);
  });

  it("offers Mark not paid only on paid fees", async () => {
    renderPage(() => jsonResponse(200, july));
    expect(within(await rowOf("Asha Rao")).queryByRole("button", { name: "Mark not paid" })).not.toBeInTheDocument();
  });

  it("pages through a long month", async () => {
    const { calls, user } = renderPage(() => jsonResponse(200, { ...july, total: 45 }));
    await rowOf("Asha Rao");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByTestId("address")).toHaveTextContent("/fees?page=2");
    expect(calls.map((c) => c.url)).toContain("/api/fees?page=2");
  });

  it("shows why the fees could not be loaded", async () => {
    renderPage(() => jsonResponse(400, { error: { code: "invalid_input", message: "month: must be a month written as YYYY-MM" } }));
    expect(await screen.findByRole("alert")).toHaveTextContent("month: must be a month written as YYYY-MM");
  });
});
