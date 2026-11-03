import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../test/fetch";
import { ChangePasswordPage, newPasswordProblem } from "./ChangePasswordPage";

const asha = { id: 7, name: "Asha", role: "student" as const, mustChangePassword: true };

async function fill(current: string, next: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Current (temporary) password"), current);
  await user.type(screen.getByLabelText("New password"), next);
  await user.type(screen.getByLabelText("New password again"), confirm);
  await user.click(screen.getByRole("button", { name: "Save new password" }));
}

describe("newPasswordProblem", () => {
  it("applies the server's rules", () => {
    expect(newPasswordProblem("temp1234", "short", "short")).toMatch(/at least 8/);
    // 25 three-byte characters = 75 bytes, past bcrypt's 72-byte limit.
    const long = "€".repeat(25);
    expect(newPasswordProblem("temp1234", long, long)).toMatch(/too long/);
    expect(newPasswordProblem("temp1234", "temp1234", "temp1234")).toMatch(/not the current/);
    expect(newPasswordProblem("temp1234", "new-secret", "new-secreT")).toMatch(/do not match/);
    expect(newPasswordProblem("temp1234", "new-secret", "new-secret")).toBeNull();
  });
});

describe("ChangePasswordPage", () => {
  it("catches a mismatch without calling the server", async () => {
    const fetch = mockFetch(async () => jsonResponse(200, {}));
    render(<ChangePasswordPage user={asha} onChanged={vi.fn()} onSignOut={vi.fn()} />);

    await fill("temp1234", "new-secret", "different");

    expect(screen.getByRole("alert")).toHaveTextContent("do not match");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts both passwords and hands over the updated user", async () => {
    const updated = { ...asha, mustChangePassword: false };
    const fetch = mockFetch(async () => jsonResponse(200, { user: updated }));
    const onChanged = vi.fn();
    render(<ChangePasswordPage user={asha} onChanged={onChanged} onSignOut={vi.fn()} />);

    await fill("temp1234", "new-secret", "new-secret");

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/auth/change-password");
    expect(JSON.parse(init!.body as string)).toEqual({
      currentPassword: "temp1234",
      newPassword: "new-secret",
    });
    expect(onChanged).toHaveBeenCalledWith(updated);
  });

  it("shows the server's message for a wrong current password", async () => {
    mockFetch(async () =>
      jsonResponse(400, {
        error: { code: "wrong_password", message: "Current password is incorrect." },
      }),
    );
    const onChanged = vi.fn();
    render(<ChangePasswordPage user={asha} onChanged={onChanged} onSignOut={vi.fn()} />);

    await fill("not-it-at-all", "new-secret", "new-secret");

    expect(await screen.findByRole("alert")).toHaveTextContent("Current password is incorrect.");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
