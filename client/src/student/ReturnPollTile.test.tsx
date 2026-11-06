import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MyOpenPoll } from "../api/returnPolls";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ReturnPollTile } from "./ReturnPollTile";

const poll: MyOpenPoll = {
  id: 6,
  title: "Back after Diwali?",
  createdAt: "2032-11-02T04:30:00Z",
  myResponse: null,
  respondedAt: null,
};

type Call = { url: string; method: string; body: unknown };

function renderTile(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  });
  const user = userEvent.setup();
  const { container } = render(<ReturnPollTile />);
  return { calls, user, container };
}

const openPolls = (...items: MyOpenPoll[]) => jsonResponse(200, { items, total: items.length });
const tile = () => screen.findByRole("region", { name: "Back after Diwali?" });

describe("ReturnPollTile", () => {
  it("shows nothing when no poll is open", async () => {
    const { calls, container } = renderTile(() => openPolls());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.url)).toEqual(["/api/return-polls"]);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the poll cannot be loaded", async () => {
    const { container } = renderTile(() => jsonResponse(500, { error: { code: "internal", message: "Down." } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("asks the open poll's question with two buttons, and records the answer", async () => {
    const { calls, user } = renderTile((call) =>
      call.method === "PUT"
        ? jsonResponse(200, { pollId: 6, response: "returned", respondedAt: "2032-11-02T06:00:00Z" })
        : openPolls(poll),
    );
    const box = await tile();
    const back = within(box).getByRole("button", { name: "I'm back" });
    const notYet = within(box).getByRole("button", { name: "Not yet" });
    expect(back).toHaveAttribute("aria-pressed", "false");
    expect(notYet).toHaveAttribute("aria-pressed", "false");
    expect(box).toHaveTextContent("Let the hostel know whether you are back.");

    await user.click(back);

    expect(calls.find((c) => c.method === "PUT")).toEqual({
      url: "/api/return-polls/6/response",
      method: "PUT",
      body: { response: "returned" },
    });
    expect(await within(box).findByText(/^Your answer: I'm back/)).toBeInTheDocument();
    expect(back).toHaveAttribute("aria-pressed", "true");
    expect(notYet).toHaveAttribute("aria-pressed", "false");
  });

  it("shows an earlier answer and lets the student change it", async () => {
    const { calls, user } = renderTile((call) =>
      call.method === "PUT"
        ? jsonResponse(200, { pollId: 6, response: "not_yet", respondedAt: "2032-11-03T06:00:00Z" })
        : openPolls({ ...poll, myResponse: "returned", respondedAt: "2032-11-02T06:00:00Z" }),
    );
    const box = await tile();
    expect(within(box).getByRole("button", { name: "I'm back" })).toHaveAttribute("aria-pressed", "true");
    expect(within(box).getByText(/^Your answer: I'm back/)).toBeInTheDocument();

    await user.click(within(box).getByRole("button", { name: "Not yet" }));
    expect(await within(box).findByText(/^Your answer: Not yet/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ response: "not_yet" }]);
  });

  it("shows the server's refusal and keeps the earlier answer", async () => {
    const { user } = renderTile((call) =>
      call.method === "PUT"
        ? jsonResponse(409, { error: { code: "poll_closed", message: "That poll is closed." } })
        : openPolls(poll),
    );
    const box = await tile();
    await user.click(within(box).getByRole("button", { name: "Not yet" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("That poll is closed.");
    expect(within(box).getByRole("button", { name: "Not yet" })).toHaveAttribute("aria-pressed", "false");
  });
});
