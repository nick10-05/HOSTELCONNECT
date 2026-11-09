import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { HostelSettings } from "../api/hostels";
import { jsonResponse, mockFetch } from "../test/fetch";
import { HostelFeesAndLimits } from "./HostelFeesAndLimits";

// Settings > Fees and limits (multi-tenant phase 5a).
const base: HostelSettings = {
  name: "SNS Hostel",
  slug: "sns-hostel",
  feesStartDate: null,
  limits: { students: 300, buildings: 20 },
  usage: { students: 102, buildings: 2 },
};

function server(settings: Partial<HostelSettings> = {}, patch: () => Response = () => jsonResponse(200, { hostel: { name: "SNS Hostel", slug: "sns-hostel" } })) {
  const sent: unknown[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/hostel" && (init?.method ?? "GET") === "GET") return jsonResponse(200, { hostel: { ...base, ...settings } });
    if (url === "/api/hostel" && init?.method === "PATCH") {
      sent.push(JSON.parse(String(init.body)));
      return patch();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No" } });
  });
  render(<HostelFeesAndLimits />);
  return { user: userEvent.setup(), sent };
}

describe("Settings > Fees and limits", () => {
  it("shows the limits and how much of them is used", async () => {
    server();
    expect(await screen.findByText("102 of 300")).toBeInTheDocument();
    expect(screen.getByText("2 of 20")).toBeInTheDocument();
  });

  it("marks a full limit", async () => {
    server({ usage: { students: 300, buildings: 2 } });
    expect(await screen.findByText(/300 of 300/)).toHaveTextContent("(full)");
  });

  it("starts tracking fees from the chosen day, sending only the date", async () => {
    const { user, sent } = server();
    const field = await screen.findByLabelText("Fees start on");
    expect(screen.getByText(/Fees are not tracked yet/)).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start tracking fees" });
    expect(start).toBeDisabled();
    await user.type(field, "2026-12-01");
    await user.click(start);
    expect(await screen.findByRole("status")).toHaveTextContent("Fees are tracked for due dates from 1 December 2026");
    expect(sent).toEqual([{ feesStartDate: "2026-12-01" }]);
    expect(screen.getByRole("button", { name: "Change start date" })).toBeDisabled();
  });

  it("shows the date already set, and what changing it does", async () => {
    server({ feesStartDate: "2026-11-15" });
    expect(await screen.findByLabelText("Fees start on")).toHaveValue("2026-11-15");
    expect(screen.getByText(/Moving it later keeps the fees already created/)).toBeInTheDocument();
  });

  it("changes a date already set to the new one", async () => {
    const { user, sent } = server({ feesStartDate: "2026-11-15" });
    const field = await screen.findByLabelText("Fees start on");
    await user.clear(field);
    await user.type(field, "2026-12-01");
    await user.click(screen.getByRole("button", { name: "Change start date" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 December 2026");
    expect(sent).toEqual([{ feesStartDate: "2026-12-01" }]);
  });

  it("shows what the server refused", async () => {
    const { user } = server({}, () => jsonResponse(400, { error: { code: "validation", message: "feesStartDate: must be within a year from today" } }));
    await user.type(await screen.findByLabelText("Fees start on"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "Start tracking fees" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("must be within a year from today");
  });
});
