import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { jsonResponse, mockFetch } from "./test/fetch";

const owner = { id: 1, name: "Owner", role: "owner", mustChangePassword: false };

function renderAt(path: string) {
  mockFetch(async (url) => {
    if (url === "/api/auth/me") return jsonResponse(200, { user: owner });
    if (url === "/api/structure") return jsonResponse(200, { buildings: [] });
    if (url.startsWith("/api/rejoin-requests?")) return jsonResponse(200, { items: [], total: 0 });
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return user;
}

describe("owner pages", () => {
  it("starts on the buildings page and moves between pages with the menu", async () => {
    const user = renderAt("/");
    expect(await screen.findByRole("heading", { name: "Buildings and rooms" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Admit student" }));
    expect(await screen.findByRole("heading", { name: "Admit a student" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Admit student" })).toHaveAttribute("aria-current", "page");
  });

  it("has a Students page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Students" }));
    expect(await screen.findByRole("heading", { name: "Students" })).toBeInTheDocument();
  });

  it("has a Rejoin requests page in the menu", async () => {
    const user = renderAt("/structure");
    await screen.findByRole("heading", { name: "Buildings and rooms" });
    await user.click(screen.getByRole("link", { name: "Rejoin requests" }));
    expect(await screen.findByRole("heading", { name: "Rejoin requests" })).toBeInTheDocument();
  });

  it("opens a page straight from its address", async () => {
    renderAt("/students/new");
    expect(await screen.findByRole("heading", { name: "Admit a student" })).toBeInTheDocument();
  });

  it("sends an unknown address to the buildings page", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByRole("heading", { name: "Buildings and rooms" })).toBeInTheDocument();
  });
});
