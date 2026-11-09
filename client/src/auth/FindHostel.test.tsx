import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { requestAccessPath, signInPath } from "../api/hostels";
import { jsonResponse, mockFetch } from "../test/fetch";
import { FindHostel, slugFrom } from "./FindHostel";
import { LoginPage } from "./LoginPage";
import { RequestAccessPage } from "./RequestAccessPage";

// Phase 6: an address without a hostel (/login, /request-access) asks for the hostel's
// address first, since every password sign-in and request names its hostel.

const notFound = () => jsonResponse(404, { error: { code: "hostel_not_found", message: "No hostel has this address." } });

function renderFinder(answer: (url: string) => Response, pathFor = signInPath) {
  const fetch = mockFetch(async (url) => answer(url));
  const goTo = vi.fn();
  const user = userEvent.setup();
  render(<FindHostel pathFor={pathFor} goTo={goTo} />);
  return { fetch, goTo, user };
}

describe("slugFrom", () => {
  it("takes the address however it is typed or pasted", () => {
    expect(slugFrom("  SNS-Hostel ")).toBe("sns-hostel");
    expect(slugFrom("/h/sns-hostel/login")).toBe("sns-hostel");
    expect(slugFrom("https://hostelconnect.onrender.com/h/sns-hostel/request-access?x=1")).toBe("sns-hostel");
    expect(slugFrom("hostelconnect.onrender.com/H/Green-View")).toBe("green-view");
    expect(slugFrom("  ")).toBe("");
  });
});

describe("FindHostel", () => {
  it("looks the hostel up and goes to its sign-in page", async () => {
    const { fetch, goTo, user } = renderFinder(() => jsonResponse(200, { hostel: { name: "SNS Hostel", slug: "sns-hostel" } }));
    await user.type(screen.getByLabelText("Your hostel's address"), "  SNS-Hostel ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith("/h/sns-hostel/login"));
    expect(fetch.mock.calls[0][0]).toBe("/api/hostels/sns-hostel");
  });

  it("takes a pasted sign-in link, and goes to the page it is asked for", async () => {
    const { goTo, user } = renderFinder(
      () => jsonResponse(200, { hostel: { name: "SNS Hostel", slug: "sns-hostel" } }),
      requestAccessPath,
    );
    await user.click(screen.getByLabelText("Your hostel's address"));
    await user.paste("https://hostelconnect.onrender.com/h/sns-hostel/login");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await vi.waitFor(() => expect(goTo).toHaveBeenCalledWith("/h/sns-hostel/request-access"));
  });

  it("says when no hostel has the address, and stays", async () => {
    const { goTo, user } = renderFinder(notFound);
    await user.type(screen.getByLabelText("Your hostel's address"), "no-such-place");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No hostel has this address. Check it with your hostel owner.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(goTo).not.toHaveBeenCalled();
  });

  it("asks for an address before looking anything up", async () => {
    const { fetch, goTo, user } = renderFinder(notFound);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your hostel's address.");
    expect(fetch).not.toHaveBeenCalled();
    expect(goTo).not.toHaveBeenCalled();
  });
});

describe("pages without a hostel in the address", () => {
  it("/login asks for the hostel and has no password sign-in, while owners keep Google and sign-up", () => {
    render(<LoginPage onLoggedIn={vi.fn()} googleEnabled signupsOpen />);
    expect(screen.getByLabelText("Your hostel's address")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in with Google" })).toHaveAttribute("href", "/api/auth/google/start");
    expect(screen.getByRole("link", { name: "Set up your hostel with Google" })).toBeInTheDocument();
  });

  it("/login shows what Google sign-in came back with", () => {
    render(<LoginPage onLoggedIn={vi.fn()} googleEnabled googleOutcome="cancelled" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in was cancelled.");
  });

  it("a hostel's own page signs in with a password, without sign-up", () => {
    render(<LoginPage onLoggedIn={vi.fn()} hostel={{ name: "SNS Hostel", slug: "sns-hostel" }} googleEnabled signupsOpen />);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your hostel's address")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set up your hostel with Google" })).not.toBeInTheDocument();
  });

  it("/request-access asks for the hostel before the form", () => {
    render(<RequestAccessPage />);
    expect(screen.getByLabelText("Your hostel's address")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email you used at the hostel")).not.toBeInTheDocument();
  });
});
