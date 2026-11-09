import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostelContext } from "../auth/hostel";
import { jsonResponse, mockFetch } from "../test/fetch";
import { HostelProfile } from "./HostelProfile";

// Settings > Hostel (multi-tenant phase 4a): the owner renames the hostel or moves its
// address.
type Sent = { method: string; body: unknown };

function renderProfile(reply: (body: Record<string, string>) => Response = (b) => jsonResponse(200, { hostel: { name: "SNS Hostel", slug: "sns-hostel", ...b } })) {
  const sent: Sent[] = [];
  mockFetch(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ method: init?.method ?? "GET", body });
    return url === "/api/hostel" ? reply(body) : jsonResponse(404, { error: { code: "not_found", message: "No" } });
  });
  const onSaved = vi.fn();
  render(
    <HostelContext.Provider value={{ name: "SNS Hostel", slug: "sns-hostel" }}>
      <HostelProfile onSaved={onSaved} />
    </HostelContext.Provider>,
  );
  return { user: userEvent.setup(), sent, onSaved };
}

describe("Settings > Hostel", () => {
  it("shows the name and where students sign in; nothing to save until something changes", () => {
    renderProfile();
    expect(screen.getByLabelText("Name")).toHaveValue("SNS Hostel");
    expect(screen.getByLabelText("Address")).toHaveValue("sns-hostel");
    expect(screen.getByText(/Students sign in at .*\/h\/sns-hostel\/login/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("renames the hostel, sending only the name", async () => {
    const { user, sent, onSaved } = renderProfile();
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "SNS Boys Hostel");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(sent).toEqual([{ method: "PATCH", body: { name: "SNS Boys Hostel" } }]);
    expect(onSaved).toHaveBeenCalledWith({ name: "SNS Boys Hostel", slug: "sns-hostel" });
  });

  it("warns that a new address changes the students' link before changing it", async () => {
    const { user, sent, onSaved } = renderProfile();
    const address = screen.getByLabelText("Address");
    await user.clear(address);
    await user.type(address, "SNS Boys");
    expect(address).toHaveValue("sns-boys");
    expect(screen.getByText(/link becomes .*\/h\/sns-boys\/login\. The old link, .*\/h\/sns-hostel\/login, stops working/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change address" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Send your students the new sign-in link");
    expect(sent).toEqual([{ method: "PATCH", body: { slug: "sns-boys" } }]);
    expect(onSaved).toHaveBeenCalledWith({ name: "SNS Hostel", slug: "sns-boys" });
  });

  it("will not send an address that cannot be one", async () => {
    const { user, sent } = renderProfile();
    const address = screen.getByLabelText("Address");
    await user.clear(address);
    await user.type(address, "ab");
    expect(screen.getByText(/Use 3 to 40 lowercase letters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change address" })).toBeDisabled();
    expect(sent).toEqual([]);
  });

  it("shows what the server refused, and keeps the change to try again", async () => {
    const { user, onSaved } = renderProfile(() =>
      jsonResponse(409, { error: { code: "slug_taken", message: "Another hostel has that address. Choose another." } }),
    );
    const address = screen.getByLabelText("Address");
    await user.clear(address);
    await user.type(address, "green-leaf");
    await user.click(screen.getByRole("button", { name: "Change address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another hostel has that address");
    await waitFor(() => expect(screen.getByRole("button", { name: "Change address" })).toBeEnabled());
    expect(address).toHaveValue("green-leaf");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
