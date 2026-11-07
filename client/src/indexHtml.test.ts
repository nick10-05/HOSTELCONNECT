import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The server's Content Security Policy allows scripts from the site itself only
// (script-src 'self'), so a script written inside index.html would be blocked in
// production. These tests keep the page free of inline scripts.

const clientDir = path.resolve(__dirname, "..");
const html = readFileSync(path.join(clientDir, "index.html"), "utf8");
const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

describe("index.html", () => {
  it("has no inline scripts: every script is loaded from a file", () => {
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scriptTags) {
      expect(attributes).toMatch(/\bsrc="[^"]+"/);
      expect(body.trim()).toBe("");
    }
  });

  it("has no inline event handlers or javascript: links", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("loads the light/dark script before the app, as a classic script so it runs before the first paint", () => {
    const sources = scriptTags.map(([, attributes]) => attributes);
    const theme = sources.findIndex((a) => a.includes('src="/theme-init.js"'));
    const app = sources.findIndex((a) => a.includes('src="/src/main.tsx"'));
    expect(theme).toBeGreaterThanOrEqual(0);
    expect(theme).toBeLessThan(app);
    expect(sources[theme]).not.toMatch(/type="module"|\bdefer\b|\basync\b/);
    expect(existsSync(path.join(clientDir, "public", "theme-init.js"))).toBe(true);
  });
});
