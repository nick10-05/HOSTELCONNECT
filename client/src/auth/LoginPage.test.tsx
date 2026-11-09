import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch";
import { LoginPage } from "./LoginPage";

const asha = { id: 7, name: "Asha", role: "student", mustChangePassword: true };
// The hostel whose address the page is at, /h/sns-hostel/login.
const SNS = { name: "SNS Hostel", slug: "sns-hostel" };

afterEach(() => {
  vi.useRealTimers();
});

async function fillAndSubmit(email = "  asha@example.com ", password = "temp-pass") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("LoginPage", () => {
  it("posts the trimmed email and the password, then hands over the user", async () => {
    const fetch = mockFetch(async () => jsonResponse(200, { user: asha }));
    const onLoggedIn = vi.fn();
    render(<LoginPage onLoggedIn={onLoggedIn} hostel={SNS} />);

    await fillAndSubmit();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse(init!.body as string)).toEqual({
      hostel: "sns-hostel",
      email: "asha@example.com",
      password: "temp-pass",
    });
    expect(onLoggedIn).toHaveBeenCalledWith(asha);
  });

  it("shows the server's message on a wrong password and clears the password field", async () => {
    mockFetch(async () =>
      jsonResponse(401, {
        error: { code: "invalid_credentials", message: "Email or password is incorrect." },
      }),
    );
    const onLoggedIn = vi.fn();
    render(<LoginPage onLoggedIn={onLoggedIn} hostel={SNS} />);

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    // Kept so the student only retypes the password. (An email input strips the spaces.)
    expect(screen.getByLabelText("Email")).toHaveValue("asha@example.com");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it("explains when the server cannot be reached", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    render(<LoginPage onLoggedIn={vi.fn()} hostel={SNS} />);

    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot reach the server");
  });

  it("sends only one request while a login is in flight", async () => {
    let finish: (r: Response) => void = () => {};
    const fetch = mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)));
    render(<LoginPage onLoggedIn={vi.fn()} hostel={SNS} />);

    const user = await fillAndSubmit();
    const button = screen.getByRole("button", { name: "Signing in…" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => finish(jsonResponse(200, { user: asha })));
  });

  it("says the server is waking up when a login takes a while", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch(() => new Promise<Response>(() => {}));
    render(<LoginPage onLoggedIn={vi.fn()} hostel={SNS} />);

    await fillAndSubmit();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("waking up");
  });

  it("can show the password while typing", async () => {
    render(<LoginPage onLoggedIn={vi.fn()} hostel={SNS} />);
    const user = userEvent.setup();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
  });
});
