import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LEGAL_VERSION, PRIVACY, TERMS } from "../legal/documents";
import { LegalPage } from "./LegalPage";

// The Terms of Service and the Privacy Policy pages (multi-tenant phase 4b).
describe("the legal pages", () => {
  it.each([
    ["terms", TERMS, "Privacy Policy", "/privacy"],
    ["privacy", PRIVACY, "Terms of Service", "/terms"],
  ] as const)("shows the %s, its version, that it is a draft, and links the other", (which, doc, otherName, otherHref) => {
    render(<LegalPage document={which} />);
    expect(screen.getByRole("heading", { level: 1, name: doc.title })).toBeInTheDocument();
    expect(screen.getByText(`Version ${LEGAL_VERSION}`)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Draft under legal review/);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(doc.sections.length);
    expect(within(screen.getByRole("navigation", { name: "More" })).getByRole("link", { name: otherName })).toHaveAttribute("href", otherHref);
    expect(document.title).toBe(`${doc.title} · HostelConnect`);
  });

  it("says what the sign-up page asks owners to accept", () => {
    const terms = JSON.stringify(TERMS);
    expect(terms).toMatch(/parent's or guardian's verifiable consent before adding a student under 18/);
    expect(terms).toMatch(/Data Processor/);
  });

  it("states the retention periods the app enforces", () => {
    const privacy = JSON.stringify(PRIVACY);
    expect(privacy).toMatch(/Complaint photos: deleted 48 hours/);
    expect(privacy).toMatch(/notifications: deleted after 60 days/);
    expect(privacy).toMatch(/up to 7 days/);
    expect(privacy).toMatch(/Singapore/);
  });
});
