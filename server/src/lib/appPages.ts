// Every address the app has a page for. Anywhere else the server answers 404 (with the
// same index.html) and the app says "Page not found", instead of showing a sign-in form
// at any made-up address such as /paypal/signin, which Google Safe Browsing reads as
// phishing. client/src/appPages.ts keeps the same list; tests/appPages.test.ts checks
// that the two lists match.
// prettier-ignore
const PAGES: RegExp[] = [
  /^\/$/,
  /^\/(login|signup|request-access|terms|privacy)$/,
  /^\/h\/[^/]+(\/(login|request-access))?$/,
  /^\/(structure|students|students\/new|rejoin-requests|complaints|complaints\/new|announcements|return-polls|food-counts|fees|settings|notices)$/,
  /^\/(students|complaints|return-polls)\/\d+$/,
];

export function isAppPage(pathname: string): boolean {
  // React Router treats /login/ as /login.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PAGES.some((page) => page.test(path));
}
