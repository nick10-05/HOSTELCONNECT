import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { TemporaryPassword } from "../owner/TemporaryPassword";
import { jsonResponse, mockFetch } from "../test/fetch";
import { HostelContext } from "./hostel";

// Multi-tenant phase 3a: each hostel's own pages at /h/<slug>/, the hostel taken from the
// address; signing out leads back to the user's own hostel's sign-in page.
const sns = { name: "SNS Hostel", slug: "sns-hostel" };
const asha = { id: 7, name: "Asha", role: "student", mustChangePassword: false };
const notFound = () => jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
      <Where />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const bodyOf = (init?: RequestInit) => JSON.parse(init!.body as string);

describe("a hostel's sign-in page", () => {
  it("names the hostel, signs in to it, and links to its own request page", async () => {
    let signedIn = false;
    const fetch = mockFetch(async (url) => {
      if (url === "/api/auth/me") {
        return signedIn ? jsonResponse(200, { user: asha, hostel: sns }) : jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      }
      if (url === "/api/hostels/sns-hostel") return jsonResponse(200, { hostel: sns });
      if (url === "/api/auth/login") {
        signedIn = true;
        return jsonResponse(200, { user: asha });
      }
      if (url === "/api/announcements?page=1" || url === "/api/complaints" || url === "/api/notifications") {
        return jsonResponse(200, { items: [], total: 0, unread: 0 });
      }
      return notFound();
    });
    const user = renderAt("/h/sns-hostel/login");

    expect(await screen.findByText("Sign in to SNS Hostel")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "/h/sns-hostel/request-access");

    await user.type(screen.getByLabelText("Email"), "asha@example.com");
    await user.type(screen.getByLabelText("Password"), "my-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const login = fetch.mock.calls.find(([url]) => url === "/api/auth/login");
    expect(bodyOf(login![1])).toEqual({ hostel: "sns-hostel", email: "asha@example.com", password: "my-password" });
    // Signed in: the student's home, not the sign-in page.
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/));
  });

  it("says so when no hostel has the address", async () => {
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      if (url === "/api/hostels/nowhere") {
        return jsonResponse(404, { error: { code: "hostel_not_found", message: "No hostel has this address." } });
      }
      return notFound();
    });
    renderAt("/h/nowhere/login");
    expect(await screen.findByRole("heading", { name: "No hostel here" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("sends /h/<slug> on its own to the sign-in page", async () => {
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      if (url === "/api/hostels/sns-hostel") return jsonResponse(200, { hostel: sns });
      return notFound();
    });
    renderAt("/h/sns-hostel/");
    expect(await screen.findByText("Sign in to SNS Hostel")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/h/sns-hostel/login");
  });
});

describe("a hostel's request-access page", () => {
  it("asks that hostel, and leads back to its sign-in page", async () => {
    const fetch = mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      if (url === "/api/hostels/sns-hostel") return jsonResponse(200, { hostel: sns });
      if (url === "/api/rejoin-requests") return jsonResponse(202, { message: "Thank you." });
      return notFound();
    });
    const user = renderAt("/h/sns-hostel/request-access");

    expect(await screen.findByText(/former residents of SNS Hostel/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/h/sns-hostel/login");
    await user.type(screen.getByLabelText("Email you used at the hostel"), "former@example.com");
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByText("Thank you.")).toBeInTheDocument();
    const sent = fetch.mock.calls.find(([url]) => url === "/api/rejoin-requests");
    expect(bodyOf(sent![1])).toMatchObject({ hostel: "sns-hostel", email: "former@example.com" });
  });
});

describe("signing out", () => {
  it("leads to the sign-in page of the user's own hostel", async () => {
    let signedIn = true;
    mockFetch(async (url) => {
      if (url === "/api/auth/me") {
        return signedIn ? jsonResponse(200, { user: asha, hostel: sns }) : jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      }
      if (url === "/api/auth/logout") {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/hostels/sns-hostel") return jsonResponse(200, { hostel: sns });
      if (url === "/api/announcements?page=1" || url === "/api/complaints" || url === "/api/notifications") {
        return jsonResponse(200, { items: [], total: 0, unread: 0 });
      }
      return notFound();
    });
    const user = renderAt("/notices");

    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Sign in to SNS Hostel")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/h/sns-hostel/login");
  });
});

describe("TemporaryPassword", () => {
  it("tells the owner where the student signs in", () => {
    render(
      <HostelContext.Provider value={sns}>
        <TemporaryPassword password="ab12cd34" />
      </HostelContext.Provider>,
    );
    expect(screen.getByText(/They sign in at/)).toHaveTextContent(`They sign in at ${window.location.host}/h/sns-hostel/login`);
  });

  it("says nothing of an address when the hostel has none", () => {
    render(<TemporaryPassword password="ab12cd34" />);
    expect(screen.queryByText(/They sign in at/)).not.toBeInTheDocument();
  });
});
