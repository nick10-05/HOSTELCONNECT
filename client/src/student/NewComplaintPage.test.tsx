import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { ComplaintDetail, RaiseStatus } from "../api/complaints";
import { jsonResponse, mockFetch } from "../test/fetch";
import { NewComplaintPage } from "./NewComplaintPage";

const created: ComplaintDetail = {
  id: 43,
  category: "electrical",
  description: "The fan in room 204 does not turn on.",
  status: "open",
  createdAt: "2026-11-05T04:30:00.000Z",
  updatedAt: "2026-11-05T04:30:00.000Z",
  resolvedAt: null,
  events: [{ kind: "created", note: null, fromStatus: null, toStatus: null, createdAt: "2026-11-05T04:30:00.000Z" }],
};

const ALLOWED: RaiseStatus = { allowed: true, reason: null, activeCategories: ["plumbing", "food"] };

// Shows where the form sent the student, and with what state.
function Landed() {
  const location = useLocation();
  return <p>Landed on {location.pathname} {JSON.stringify(location.state)}</p>;
}

// A fake server: GET /api/complaints?page=1 answers canRaise; POST /api/complaints is
// recorded and answered by `answer`.
function fakeServer(canRaise: RaiseStatus, answer: () => Response = () => jsonResponse(201, created)) {
  const posts: unknown[] = [];
  mockFetch(async (url, init) => {
    if (url === "/api/complaints?page=1") return jsonResponse(200, { items: [], total: 0, canRaise });
    if (url === "/api/complaints" && init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return answer();
    }
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/complaints/new"]}>
      <Routes>
        <Route path="/complaints/new" element={<NewComplaintPage />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
  return { user, posts };
}

const category = () => screen.getByLabelText("Category");
const description = () => screen.getByLabelText("What is wrong?");
const send = () => screen.getByRole("button", { name: "Send complaint" });

describe("NewComplaintPage", () => {
  it("offers the eight categories, with those already active shown as unavailable", async () => {
    fakeServer(ALLOWED);
    await screen.findByRole("heading", { name: "New complaint" });
    await screen.findByLabelText("Category");

    const options = within(category()).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a category",
      "Plumbing (already active)",
      "Electrical",
      "Cleanliness",
      "Internet",
      "Food (already active)",
      "Furniture",
      "Security",
      "Other",
    ]);
    expect(screen.getByRole("option", { name: "Plumbing (already active)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Food (already active)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Electrical" })).toBeEnabled();
    expect(category()).toHaveAccessibleDescription(
      "You already have an active complaint in Plumbing, Food. You can raise another one there when it is resolved or rejected.",
    );
  });

  it("enables Send only with a category and 10 to 500 characters after trimming", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    expect(send()).toBeDisabled();

    await user.selectOptions(category(), "electrical");
    await user.type(description(), "   Fan off   ");
    // Spaces at the ends do not count.
    expect(screen.getByText("7 / 500")).toBeInTheDocument();
    expect(screen.getByText("At least 10 characters")).toBeInTheDocument();
    expect(send()).toBeDisabled();

    await user.type(description(), "{Backspace}{Backspace}{Backspace} again");
    expect(screen.getByText("13 / 500")).toBeInTheDocument();
    expect(send()).toBeEnabled();
  });

  it("counts an emoji as one character, as the server does", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "other");
    await user.click(description());
    await user.paste("😀".repeat(5));
    expect(screen.getByText("5 / 500")).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it("marks a description over 500 characters and keeps Send disabled", async () => {
    const { user } = fakeServer({ allowed: true, reason: null, activeCategories: [] });
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "other");
    await user.click(description());
    await user.paste("x".repeat(501));

    expect(screen.getByText("501 / 500")).toBeInTheDocument();
    expect(screen.getByText("Too long")).toBeInTheDocument();
    expect(description()).toHaveAttribute("aria-invalid", "true");
    expect(send()).toBeDisabled();
  });

  it("sends the trimmed complaint and opens it", async () => {
    const { user, posts } = fakeServer(ALLOWED);
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "electrical");
    await user.type(description(), "  The fan in room 204 does not turn on.  ");
    await user.click(send());

    expect(await screen.findByText('Landed on /complaints/43 {"created":true}')).toBeInTheDocument();
    expect(posts).toEqual([{ category: "electrical", description: "The fan in room 204 does not turn on." }]);
  });

  it("shows the server's refusal word for word and lets the student try again", async () => {
    const message = "You can raise at most 2 complaints in 24 hours. Please try again later.";
    const { user, posts } = fakeServer(ALLOWED, () =>
      jsonResponse(429, { error: { code: "too_many_recent", message } }),
    );
    await screen.findByLabelText("Category");
    await user.selectOptions(category(), "security");
    await user.type(description(), "The main gate lock is broken.");
    await user.click(send());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(posts).toHaveLength(1);
    expect(send()).toBeEnabled();
    expect(description()).toHaveValue("The main gate lock is broken.");
  });

  it("shows the reason instead of the form when a limit is already reached", async () => {
    const reason = "You already have 3 active complaints. You can raise a new one when one of them is resolved or rejected.";
    fakeServer({ allowed: false, reason, activeCategories: ["plumbing", "food", "internet"] });

    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
    expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send complaint" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← My complaints" })).toHaveAttribute("href", "/");
  });
});
