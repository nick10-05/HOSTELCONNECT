import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Announcement } from "../api/announcements";
import { jsonResponse, mockFetch } from "../test/fetch";
import { AnnouncementsPage } from "./AnnouncementsPage";

const water: Announcement = {
  id: 1,
  title: "Water off on Sunday",
  body: "The tank is being cleaned from 9 am to 1 pm.\nPlease store water the night before.",
  isUrgent: false,
  isPinned: false,
  createdAt: "2026-11-04T03:30:00.000Z", // 9:00 am in India
  updatedAt: "2026-11-04T03:30:00.000Z",
};
const mess: Announcement = {
  ...water,
  id: 2,
  title: "Mess closed on Monday",
  body: "Dinner will be served at the canteen.",
  isPinned: true,
  createdAt: "2026-11-03T03:30:00.000Z",
  updatedAt: "2026-11-04T04:30:00.000Z", // edited at 10:00 am
};

type Call = { method: string; url: string; body: unknown };

// A fake server: a list of notices that the writes change, unless `refuse` answers.
function fakeServer(start: Announcement[], refuse?: (call: Call) => Response | undefined, total?: number) {
  let notices = [...start];
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const refusal = refuse?.(call);
    if (refusal) return refusal;
    if (call.method === "GET") return jsonResponse(200, { items: notices, total: total ?? notices.length });
    if (call.method === "POST") {
      const posted = { ...water, id: 99, ...(call.body as object) };
      notices = [posted, ...notices];
      return jsonResponse(201, posted);
    }
    const id = Number(url.split("/").pop());
    if (call.method === "PATCH") {
      notices = notices.map((n) => (n.id === id ? { ...n, ...(call.body as object) } : n));
      return jsonResponse(200, notices.find((n) => n.id === id));
    }
    notices = notices.filter((n) => n.id !== id);
    return new Response(null, { status: 204 });
  });
  const writes = () => calls.filter((c) => c.method !== "GET");
  const gets = () => calls.filter((c) => c.method === "GET").map((c) => c.url);
  return { writes, gets };
}

function renderPage(path = "/announcements") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AnnouncementsPage />
    </MemoryRouter>,
  );
  return user;
}

const card = (title: string) => screen.getByRole("article", { name: title });
const postForm = () => screen.getByRole("form", { name: "Post a notice" });

describe("AnnouncementsPage: the list", () => {
  it("shows each notice with its text, labels and times", async () => {
    const server = fakeServer([mess, water]);
    renderPage();

    const pinned = await screen.findByRole("article", { name: "Mess closed on Monday" });
    expect(server.gets()).toEqual(["/api/announcements?page=1"]);
    expect(pinned).toHaveTextContent("Pinned");
    expect(pinned).not.toHaveTextContent("Urgent");
    expect(pinned).toHaveTextContent("Posted 3 Nov 2026, 9:00 am · edited 4 Nov 2026, 10:00 am");
    const plain = card("Water off on Sunday");
    expect(plain).toHaveTextContent("Please store water the night before.");
    expect(plain).toHaveTextContent("Posted 4 Nov 2026, 9:00 am");
    expect(plain).not.toHaveTextContent("edited");
    // In the server's order.
    expect(
      within(screen.getByRole("list", { name: "Notices" }))
        .getAllByRole("article")
        .map((a) => a.getAttribute("aria-labelledby")),
    ).toEqual(["notice-2", "notice-1"]);
  });

  it("says when there are no notices yet", async () => {
    fakeServer([]);
    renderPage();
    expect(await screen.findByText("No notices yet.")).toBeInTheDocument();
  });

  it("pages through older notices", async () => {
    const server = fakeServer([water], undefined, 25);
    const user = renderPage();
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.gets()).toContain("/api/announcements?page=2"));
  });
});

describe("AnnouncementsPage: posting", () => {
  it("posts the trimmed text with Urgent and Pin, confirms, clears the form and reloads", async () => {
    const server = fakeServer([water]);
    const user = renderPage();
    await screen.findByRole("article", { name: "Water off on Sunday" });

    await user.type(within(postForm()).getByLabelText("Title"), "  Power cut tonight ");
    await user.type(within(postForm()).getByLabelText("Notice"), " From 11 pm to 2 am. ");
    await user.click(within(postForm()).getByLabelText("Urgent"));
    await user.click(within(postForm()).getByLabelText("Pin to the top"));
    await user.click(within(postForm()).getByRole("button", { name: "Post" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Posted. Every current student has been notified.");
    expect(server.writes()).toEqual([
      {
        method: "POST",
        url: "/api/announcements",
        body: { title: "Power cut tonight", body: "From 11 pm to 2 am.", isUrgent: true, isPinned: true },
      },
    ]);
    expect(await screen.findByRole("article", { name: "Power cut tonight" })).toHaveTextContent("Urgent");
    expect(within(postForm()).getByLabelText("Title")).toHaveValue("");
    expect(within(postForm()).getByLabelText("Urgent")).not.toBeChecked();
  });

  it("keeps Post off until title and notice both fit, counting an emoji as one character", async () => {
    fakeServer([]);
    const user = renderPage();
    await screen.findByText("No notices yet.");
    const post = () => within(postForm()).getByRole("button", { name: "Post" });
    expect(post()).toBeDisabled();

    await user.type(within(postForm()).getByLabelText("Title"), "   ");
    await user.type(within(postForm()).getByLabelText("Notice"), "Text.");
    expect(post()).toBeDisabled(); // a blank title

    await user.clear(within(postForm()).getByLabelText("Title"));
    await user.click(within(postForm()).getByLabelText("Title"));
    await user.paste("📢".repeat(120));
    expect(within(postForm()).getByText("120 / 120")).toBeInTheDocument();
    expect(post()).toBeEnabled();

    await user.paste("x");
    expect(within(postForm()).getByText("121 / 120")).toBeInTheDocument();
    expect(post()).toBeDisabled();
  });

  it("shows the server's refusal and keeps what was typed", async () => {
    fakeServer([], (call) =>
      call.method === "POST"
        ? jsonResponse(400, { error: { code: "invalid_input", message: "title: can be at most 120 characters" } })
        : undefined,
    );
    const user = renderPage();
    await screen.findByText("No notices yet.");
    await user.type(within(postForm()).getByLabelText("Title"), "Title");
    await user.type(within(postForm()).getByLabelText("Notice"), "Body");
    await user.click(within(postForm()).getByRole("button", { name: "Post" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("title: can be at most 120 characters");
    expect(within(postForm()).getByLabelText("Title")).toHaveValue("Title");
  });
});

describe("AnnouncementsPage: changing a notice", () => {
  it("pins and unpins, sending only isPinned", async () => {
    const server = fakeServer([water]);
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Water off on Sunday" })).getByRole("button", { name: "Pin" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Pinned.");
    await user.click(within(await screen.findByRole("article", { name: "Water off on Sunday" })).getByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Unpinned."));
    expect(server.writes()).toEqual([
      { method: "PATCH", url: "/api/announcements/1", body: { isPinned: true } },
      { method: "PATCH", url: "/api/announcements/1", body: { isPinned: false } },
    ]);
  });

  it("marks urgent and not urgent, sending only isUrgent", async () => {
    const server = fakeServer([water]);
    const user = renderPage();
    await user.click(
      within(await screen.findByRole("article", { name: "Water off on Sunday" })).getByRole("button", { name: "Mark urgent" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Marked urgent.");
    expect(await screen.findByRole("button", { name: "Not urgent" })).toBeInTheDocument();
    expect(server.writes()).toEqual([{ method: "PATCH", url: "/api/announcements/1", body: { isUrgent: true } }]);
  });

  it("edits only what changed, and says students are not notified again", async () => {
    const server = fakeServer([water]);
    const user = renderPage();
    await user.click(within(await screen.findByRole("article", { name: "Water off on Sunday" })).getByRole("button", { name: "Edit" }));

    const form = screen.getByRole("form", { name: "Edit Water off on Sunday" });
    expect(form).toHaveTextContent("Editing does not notify students again.");
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled(); // nothing changed yet
    await user.clear(within(form).getByLabelText("Title"));
    await user.type(within(form).getByLabelText("Title"), " Water off on Monday ");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved. Students were not notified again.");
    expect(server.writes()).toEqual([
      { method: "PATCH", url: "/api/announcements/1", body: { title: "Water off on Monday" } },
    ]);
    expect(await screen.findByRole("article", { name: "Water off on Monday" })).toBeInTheDocument();
  });

  it("deletes only after the owner confirms, and Cancel sends nothing", async () => {
    const server = fakeServer([water, mess]);
    const user = renderPage();
    const notice = await screen.findByRole("article", { name: "Water off on Sunday" });

    await user.click(within(notice).getByRole("button", { name: "Delete" }));
    const confirm = within(notice).getByRole("group", { name: "Confirm delete" });
    expect(confirm).toHaveTextContent("Delete this notice? It also disappears from every student's notifications.");
    expect(server.writes()).toEqual([]);

    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(notice).queryByRole("group", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(server.writes()).toEqual([]);

    await user.click(within(notice).getByRole("button", { name: "Delete" }));
    await user.click(within(notice).getByRole("button", { name: "Yes, delete" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Deleted. It is gone from every student's notifications.");
    expect(server.writes()).toEqual([{ method: "DELETE", url: "/api/announcements/1", body: undefined }]);
    await waitFor(() => expect(screen.queryByRole("article", { name: "Water off on Sunday" })).not.toBeInTheDocument());
    expect(card("Mess closed on Monday")).toBeInTheDocument();
  });

  it("shows a refusal as the server words it", async () => {
    fakeServer([water], (call) =>
      call.method === "DELETE"
        ? jsonResponse(404, { error: { code: "announcement_not_found", message: "That announcement does not exist." } })
        : undefined,
    );
    const user = renderPage();
    const notice = await screen.findByRole("article", { name: "Water off on Sunday" });
    await user.click(within(notice).getByRole("button", { name: "Delete" }));
    await user.click(within(notice).getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That announcement does not exist.");
  });
});
