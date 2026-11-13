import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShell } from "./AuthShell";

// Every page before sign-in says what HostelConnect is and links the Terms and the
// Privacy Policy (Safe Browsing "Deceptive pages", 2026-11-10). Who runs it and a contact
// address join once Nikhil has decided on them (client/src/legal/operator.ts): until then
// the footer shows no [placeholder].
describe("AuthShell", () => {
  it("says what HostelConnect is, with Terms and Privacy, and no placeholder", () => {
    render(
      <AuthShell title="Welcome back">
        <p>form</p>
      </AuthShell>,
    );
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent(/hostel owners/i);
    expect(footer.textContent).not.toMatch(/[[\]]/);
    const links = within(footer).getByRole("navigation", { name: "About HostelConnect" });
    expect(within(links).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(links).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(within(links).getAllByRole("link")).toHaveLength(2);
  });
});
