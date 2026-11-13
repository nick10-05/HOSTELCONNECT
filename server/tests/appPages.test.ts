import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAppPage } from "../src/lib/appPages";

// The addresses the app has a page for (Safe Browsing "Deceptive pages", 2026-11-10):
// anywhere else the server answers 404, and the app says "Page not found".
describe("isAppPage", () => {
  it.each([
    "/",
    "/login",
    "/login/",
    "/signup",
    "/request-access",
    "/terms",
    "/privacy",
    "/h/sns-hostel",
    "/h/sns-hostel/login",
    "/h/sns-hostel/request-access",
    "/structure",
    "/students",
    "/students/new",
    "/students/12",
    "/rejoin-requests",
    "/complaints",
    "/complaints/new",
    "/complaints/3",
    "/announcements",
    "/return-polls",
    "/return-polls/6",
    "/food-counts",
    "/fees",
    "/settings",
    "/notices",
  ])("knows %s", (page) => {
    expect(isAppPage(page)).toBe(true);
  });

  it.each([
    "/paypal/signin",
    "/office365/verify-account",
    "/wp-login.php",
    "/login/verify",
    "/h/sns-hostel/login/extra",
    "/h/sns-hostel/verify",
    "/students/abc",
    "/settings/security",
    "/.env",
    "/robots.txt",
  ])("does not know %s", (page) => {
    expect(isAppPage(page)).toBe(false);
  });

  it("is the same list as the app's own", () => {
    const pages = (file: string) => {
      const text = readFileSync(path.resolve(__dirname, file), "utf8").replace(/\r\n/g, "\n");
      const list = /const PAGES: RegExp\[\] = \[[\s\S]*?\n\];/.exec(text);
      expect(list, file).not.toBeNull();
      return list![0];
    };
    expect(pages("../src/lib/appPages.ts")).toBe(pages("../../client/src/appPages.ts"));
  });
});
