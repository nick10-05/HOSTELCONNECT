import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_DAYS_KEPT } from "../src/jobs/pruneNotifications";
import { TERMS_VERSION } from "../src/lib/legal";
import { PHOTO_KEEP_HOURS } from "../src/services/complaints";
import { SESSION_TTL_SECONDS } from "../src/lib/token";

// The Terms and the Privacy Policy are shown by the client (client/src/legal/documents.ts)
// and accepted at sign-up by the version the server names (multi-tenant phase 4b). The two
// must agree, and what the policy promises must be what the server does.
const documents = readFileSync(path.join(__dirname, "../../client/src/legal/documents.ts"), "utf8");

describe("the legal documents", () => {
  it("carry the version owners accept at sign-up", () => {
    expect(documents).toContain(`export const LEGAL_VERSION = "${TERMS_VERSION}";`);
  });

  it("state the photo, notification and sign-in periods the server uses", () => {
    expect(documents).toContain(`Complaint photos: deleted ${PHOTO_KEEP_HOURS} hours`);
    expect(documents).toContain(`notifications: deleted after ${NOTIFICATION_DAYS_KEPT} days`);
    expect(documents).toContain(`for up to ${SESSION_TTL_SECONDS / 86400} days`);
  });
});
