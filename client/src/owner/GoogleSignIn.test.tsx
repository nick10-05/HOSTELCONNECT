import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { AccountContext } from "../auth/hostel";
import { LoginPage } from "../auth/LoginPage";
import { jsonResponse, mockFetch } from "../test/fetch";
import { GoogleSignIn } from "./GoogleSignIn";

// Google sign-in for owners, on the client (multi-tenant phase 3b): the button on the
// sign-in page, what Google sign-in came back with, and the owner's Sign-in settings.
const unauthenticated = () => jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });

describe("the sign-in page", () => {
  it("offers owners Google sign-in when the server has it set up", async () => {
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return unauthenticated();
      if (url === "/api/auth/options") return jsonResponse(200, { google: true });
      return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
    });
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/auth/google/start");
  });

  it("does not offer it otherwise", () => {
    render(<LoginPage onLoggedIn={() => {}} />);
    expect(screen.queryByRole("link", { name: "Sign in with Google" })).not.toBeInTheDocument();
  });

  it.each([
    ["no-account", /No HostelConnect owner account uses that Google account/],
    ["inactive", /not active/],
    ["cancelled", /cancelled/],
    ["failed", /did not work/],
  ])("explains ?google=%s", (outcome, message) => {
    render(<LoginPage onLoggedIn={() => {}} googleEnabled googleOutcome={outcome} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("ignores an unknown ?google= value", () => {
    render(<LoginPage onLoggedIn={() => {}} googleEnabled googleOutcome="<script>" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

function renderSettings(account: { googleLinked: boolean; hasPassword: boolean; googleEnabled: boolean }, search = "") {
  render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <AccountContext.Provider value={account}>
        <GoogleSignIn />
      </AccountContext.Provider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe("the owner's Sign-in settings", () => {
  it("offers to link Google while none is linked", () => {
    renderSettings({ googleLinked: false, hasPassword: true, googleEnabled: true });
    expect(screen.getByRole("link", { name: "Link Google account" })).toHaveAttribute("href", "/api/auth/google/link");
    expect(screen.queryByRole("button", { name: "Remove password" })).not.toBeInTheDocument();
  });

  it("says what linking came back with", () => {
    renderSettings({ googleLinked: true, hasPassword: true, googleEnabled: true }, "?google=linked");
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("Your Google account is linked");
  });

  it("explains a Google account already in use", () => {
    renderSettings({ googleLinked: false, hasPassword: true, googleEnabled: true }, "?google=taken");
    expect(screen.getByRole("status")).toHaveTextContent("already signs in to another HostelConnect account");
  });

  it("removes the password with the current one, then says Google only", async () => {
    const fetch = mockFetch(async (url, init) => {
      if (url === "/api/auth/remove-password") {
        const { currentPassword } = JSON.parse(init!.body as string);
        return currentPassword === "my-password"
          ? new Response(null, { status: 204 })
          : jsonResponse(400, { error: { code: "wrong_password", message: "Current password is incorrect." } });
      }
      return jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
    });
    const user = renderSettings({ googleLinked: true, hasPassword: true, googleEnabled: true });

    await user.type(screen.getByLabelText("Current password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current password is incorrect.");

    await user.type(screen.getByLabelText("Current password"), "my-password");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByText("You sign in with Google only.")).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/auth/remove-password")).toHaveLength(2);
  });

  it("says Google only when there is no password", () => {
    renderSettings({ googleLinked: true, hasPassword: false, googleEnabled: true });
    expect(screen.getByText("You sign in with Google only.")).toBeInTheDocument();
  });

  it("is hidden while Google sign-in is not set up and nothing is linked", () => {
    renderSettings({ googleLinked: false, hasPassword: true, googleEnabled: false });
    expect(screen.queryByRole("heading", { name: "Sign-in" })).not.toBeInTheDocument();
  });
});
