import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { jsonResponse, mockFetch } from "../test/fetch";
import { LoginPage } from "./LoginPage";
import { RequestAccessPage } from "./RequestAccessPage";

// The hostel whose address the page is at, /h/sns-hostel/request-access.
const SNS = { name: "SNS Hostel", slug: "sns-hostel" };
const ANSWER = "If this email belongs to a former student, the owner will review the request.";

function renderPage(answer: () => Response = () => jsonResponse(202, { message: ANSWER })) {
  const fetch = mockFetch(async () => answer());
  const user = userEvent.setup();
  render(<RequestAccessPage hostel={SNS} />);
  return { user, fetch };
}

describe("RequestAccessPage", () => {
  it("sends the trimmed email and message, and shows the server's sentence instead of the form", async () => {
    const { user, fetch } = renderPage();
    await user.type(screen.getByLabelText("Email you used at the hostel"), "  ravi@example.com ");
    await user.type(screen.getByLabelText("Message for the owner (optional)"), "  Back in June.  ");
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByRole("status")).toHaveTextContent(ANSWER);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/rejoin-requests");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ hostel: "sns-hostel", email: "ravi@example.com", message: "Back in June." });
    expect(screen.queryByRole("button", { name: "Send request" })).not.toBeInTheDocument();
  });

  it("counts the message in characters, and will not send more than 500", async () => {
    const { user, fetch } = renderPage();
    const box = screen.getByLabelText("Message for the owner (optional)");
    expect(screen.getByText("0 / 500")).toBeInTheDocument();

    await user.type(box, "🙂🙂");
    expect(screen.getByText("2 / 500")).toBeInTheDocument();

    await user.clear(box);
    await user.click(box);
    await user.paste("x".repeat(501));
    expect(screen.getByText("501 / 500")).toBeInTheDocument();
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a refusal, such as too many requests, and lets the person try again", async () => {
    const { user } = renderPage(() =>
      jsonResponse(429, {
        error: { code: "rate_limited", message: "Too many requests from here. Please try again later." },
      }),
    );
    await user.type(screen.getByLabelText("Email you used at the hostel"), "ravi@example.com");
    await user.click(screen.getByRole("button", { name: "Send request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests from here.");
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });

  it("links back to sign in", () => {
    renderPage();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/h/sns-hostel/login");
  });
});

describe("getting to the request form", () => {
  it("is linked from the sign-in page", () => {
    render(<LoginPage onLoggedIn={() => {}} />);
    expect(screen.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "/request-access");
  });

  it("opens at /request-access when nobody is signed in, and sign-in shows everywhere else", async () => {
    mockFetch(async () => jsonResponse(401, { error: { code: "unauthenticated", message: "Please sign in." } }));
    const { unmount } = render(
      <MemoryRouter initialEntries={["/request-access"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Request access" })).toBeInTheDocument();
    // No hostel in the address: the page asks for it first (phase 6).
    expect(screen.getByLabelText("Your hostel's address")).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={["/students"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your hostel's address")).toBeInTheDocument();
  });
});
