import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch";
import { SignOutOtherDevices } from "./SignOutOtherDevices";

// "Sign out of other devices" (security audit): asks first, then ends every other sign-in.
function server(answer: () => Response) {
  const posts: string[] = [];
  mockFetch(async (url, init) => {
    if (init?.method === "POST") posts.push(url);
    if (url === "/api/auth/sign-out-others" && init?.method === "POST") return answer();
    return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
  });
  const user = userEvent.setup();
  render(<SignOutOtherDevices />);
  return { user, posts };
}

describe("signing out of other devices", () => {
  it("asks first, and Cancel sends nothing", async () => {
    const { user, posts } = server(() => new Response(null, { status: 204 }));
    await user.click(screen.getByRole("button", { name: "Sign out of other devices" }));
    expect(screen.getByText("Sign out on every other phone and computer?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Sign out of other devices" })).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it("signs the other devices out and says so", async () => {
    const { user, posts } = server(() => new Response(null, { status: 204 }));
    await user.click(screen.getByRole("button", { name: "Sign out of other devices" }));
    await user.click(screen.getByRole("button", { name: "Yes, sign out others" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Signed out on every other device.");
    expect(posts).toEqual(["/api/auth/sign-out-others"]);
  });

  it("shows a refusal and keeps the question open", async () => {
    const { user } = server(() => jsonResponse(500, { error: { code: "internal", message: "Something went wrong." } }));
    await user.click(screen.getByRole("button", { name: "Sign out of other devices" }));
    await user.click(screen.getByRole("button", { name: "Yes, sign out others" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.getByRole("button", { name: "Yes, sign out others" })).toBeEnabled();
  });
});
