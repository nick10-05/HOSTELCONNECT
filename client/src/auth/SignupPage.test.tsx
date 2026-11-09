import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { isSlug, suggestSlug } from "../api/signup";
import { jsonResponse, mockFetch } from "../test/fetch";
import { LoginPage } from "./LoginPage";
import { SignupPage } from "./SignupPage";

// Sign-up on the client (multi-tenant phase 4a).
const notFound = () => jsonResponse(404, { error: { code: "not_found", message: "No such endpoint" } });
const ticket = { email: "asha@gmail.com", termsVersion: "2026-11-draft-1" };

type Call = { url: string; method: string; body?: unknown };

// A server with a sign-up ticket. `taken` addresses are another hostel's.
function serverWithTicket(opts: { taken?: string[]; post?: (body: Record<string, unknown>) => Response } = {}) {
  const calls: Call[] = [];
  mockFetch(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url === "/api/signup" && (init?.method ?? "GET") === "GET") return jsonResponse(200, ticket);
    if (url.startsWith("/api/signup/slug?slug=")) {
      const slug = decodeURIComponent(url.split("=")[1]);
      if (!isSlug(slug)) return jsonResponse(200, { available: false, reason: "invalid" });
      return jsonResponse(200, opts.taken?.includes(slug) ? { available: false, reason: "taken" } : { available: true });
    }
    if (url === "/api/signup" && init?.method === "POST") {
      return opts.post ? opts.post(body) : jsonResponse(201, { user: { id: 9, name: body.ownerName, role: "owner", mustChangePassword: false } });
    }
    return notFound();
  });
  return calls;
}

function renderSignup(onSignedUp = vi.fn()) {
  render(<SignupPage onSignedUp={onSignedUp} />);
  return { user: userEvent.setup(), onSignedUp };
}

async function fillIn(user: ReturnType<typeof userEvent.setup>, hostel = "Green Leaf Hostel") {
  await user.type(await screen.findByLabelText("Your name"), "Asha Rao");
  await user.type(screen.getByLabelText("Hostel name"), hostel);
}

describe("suggestSlug", () => {
  it.each([
    ["Green Leaf Hostel", "green-leaf-hostel"],
    ["Sri Sai Boys' Hostel", "sri-sai-boys-hostel"],
    ["  Café  Résidence -- 2 ", "cafe-residence-2"],
    ["!!!", ""],
    ["a".repeat(50), "a".repeat(40)],
    [`${"a".repeat(39)} b`, "a".repeat(39)],
  ])("%s -> %s", (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
  });
});

describe("the sign-up page", () => {
  it("shows the Google account's email, and makes the address from the hostel's name", async () => {
    serverWithTicket();
    const { user } = renderSignup();
    expect(await screen.findByText("Signing up as asha@gmail.com")).toBeInTheDocument();
    await fillIn(user);
    expect(screen.getByLabelText("Hostel address")).toHaveValue("green-leaf-hostel");
    expect(await screen.findByText(/\/h\/green-leaf-hostel\/login \(free\)/)).toBeInTheDocument();
  });

  it("creates the hostel with the accepted terms' version, and signs the owner in", async () => {
    const calls = serverWithTicket();
    const { user, onSignedUp } = renderSignup();
    await fillIn(user);
    const create = screen.getByRole("button", { name: "Create my hostel" });
    expect(create).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(create);
    await waitFor(() => expect(onSignedUp).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", name: "Asha Rao" })));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      ownerName: "Asha Rao",
      hostelName: "Green Leaf Hostel",
      slug: "green-leaf-hostel",
      termsVersion: "2026-11-draft-1",
      acceptTerms: true,
    });
  });

  it("links the Terms and the Privacy Policy, and asks about students under 18", async () => {
    serverWithTicket();
    renderSignup();
    expect(await screen.findByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(/consent before adding any student under 18/);
  });

  it("says when an address is taken or not allowed, and will not send it", async () => {
    serverWithTicket({ taken: ["green-leaf-hostel"] });
    const { user } = renderSignup();
    await fillIn(user);
    await user.click(screen.getByRole("checkbox"));
    expect(await screen.findByText(/Another hostel has that address/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my hostel" })).toBeDisabled();

    const address = screen.getByLabelText("Hostel address");
    await user.clear(address);
    await user.type(address, "Green Leaf 2");
    expect(address).toHaveValue("green-leaf-2");
    // What the server said about the old address is not said about the new one.
    expect(screen.queryByText(/Another hostel has that address/)).not.toBeInTheDocument();
    expect(await screen.findByText(/\(free\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create my hostel" })).toBeEnabled();

    await user.clear(address);
    await user.type(address, "a-");
    expect(screen.getByText(/Use 3 to 40 lowercase letters/)).toBeInTheDocument();
    expect(address).toHaveAttribute("aria-invalid", "true");
  });

  it("shows what the server refused, and keeps the form", async () => {
    serverWithTicket({
      post: () => jsonResponse(409, { error: { code: "terms_changed", message: "The terms have changed since this page was opened." } }),
    });
    const { user, onSignedUp } = renderSignup();
    await fillIn(user);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Create my hostel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The terms have changed");
    expect(screen.getByLabelText("Your name")).toHaveValue("Asha Rao");
    expect(onSignedUp).not.toHaveBeenCalled();
  });

  it("sends a visitor without a ticket to Google first", async () => {
    mockFetch(async () => jsonResponse(401, { error: { code: "signup_not_started", message: "Start by choosing your Google account." } }));
    renderSignup();
    expect(await screen.findByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/api/auth/google/start");
    expect(screen.queryByLabelText("Your name")).not.toBeInTheDocument();
  });

  it("says when sign-up is closed, with no way on", async () => {
    mockFetch(async () => jsonResponse(403, { error: { code: "signups_closed", message: "New hostels cannot sign up yet." } }));
    renderSignup();
    expect(await screen.findByText("New hostels cannot sign up yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue with Google" })).not.toBeInTheDocument();
  });
});

describe("the sign-in page while sign-up is open", () => {
  it("offers to set up a hostel, through Google", () => {
    render(<LoginPage onLoggedIn={() => {}} googleEnabled signupsOpen />);
    expect(screen.getByRole("link", { name: "Set up your hostel with Google" })).toHaveAttribute("href", "/api/auth/google/start");
  });

  it("does not on a hostel's own page, or while sign-up is closed", () => {
    const { unmount } = render(<LoginPage onLoggedIn={() => {}} googleEnabled signupsOpen hostel={{ name: "SNS", slug: "sns-hostel" }} />);
    expect(screen.queryByRole("link", { name: /Set up your hostel/ })).not.toBeInTheDocument();
    unmount();
    render(<LoginPage onLoggedIn={() => {}} googleEnabled />);
    expect(screen.queryByRole("link", { name: /Set up your hostel/ })).not.toBeInTheDocument();
  });

  it("is told by the server whether sign-up is open", async () => {
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      if (url === "/api/auth/options") return jsonResponse(200, { google: true, signupsOpen: true });
      return notFound();
    });
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("link", { name: "Set up your hostel with Google" })).toBeInTheDocument();
  });
});

describe("the app's sign-up and legal addresses", () => {
  const signedOut = (extra: (url: string) => Response | undefined = () => undefined) =>
    mockFetch(async (url) => {
      if (url === "/api/auth/me") return jsonResponse(401, { error: { code: "unauthenticated", message: "Sign in" } });
      if (url === "/api/auth/options") return jsonResponse(200, { google: true, signupsOpen: true });
      return extra(url) ?? notFound();
    });

  it("shows the sign-up page at /signup", async () => {
    signedOut((url) => (url === "/api/signup" ? jsonResponse(200, ticket) : undefined));
    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("Hostel name")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set up your hostel" })).toBeInTheDocument();
  });

  it.each([
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Policy"],
  ])("shows %s, signed out or in", async (path, title) => {
    signedOut();
    const { unmount } = render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    unmount();

    mockFetch(async (url) => {
      if (url === "/api/auth/me") {
        return jsonResponse(200, {
          user: { id: 1, name: "Student", role: "student", mustChangePassword: false },
          hostel: { name: "SNS", slug: "sns-hostel" },
        });
      }
      return notFound();
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });
});
