import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { brevoMailer, consoleMailer, MailError, mailerFromConfig, maskEmail } from "../src/lib/mailer";

// lib/mailer.ts: email through Brevo's HTTP API, and the settings that turn it on.
const KEY = "xkeysib-0123456789abcdef0123456789abcdef";
const BASE = { DATABASE_URL: "postgres://app:pw@localhost:5432/hostelconnect", JWT_SECRET: "x".repeat(32) };

describe("brevoMailer", () => {
  it("posts the email to Brevo with the API key, as plain text", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messageId: "<1@brevo>" }), { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    await brevoMailer({ apiKey: KEY, from: "codes@example.com", fromName: "HostelConnect", fetch }).send({
      to: "owner@example.com",
      subject: "Your code",
      text: "123456",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["api-key"]).toBe(KEY);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      sender: { email: "codes@example.com", name: "HostelConnect" },
      to: [{ email: "owner@example.com" }],
      subject: "Your code",
      textContent: "123456",
    });
  });

  it("turns a refusal or no answer into a MailError that repeats nothing sent", async () => {
    const refusing = (async () => new Response("bad key " + KEY, { status: 401 })) as unknown as typeof globalThis.fetch;
    const err = await brevoMailer({ apiKey: KEY, from: "a@b.co", fromName: "H", fetch: refusing })
      .send({ to: "o@b.co", subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ status: 401 });
    expect(String((err as Error).message)).not.toContain(KEY);

    const offline = (async () => {
      throw new Error(`connect failed ${KEY}`);
    }) as unknown as typeof globalThis.fetch;
    const none = await brevoMailer({ apiKey: KEY, from: "a@b.co", fromName: "H", fetch: offline })
      .send({ to: "o@b.co", subject: "s", text: "t" })
      .catch((e: unknown) => e);
    expect(none).toMatchObject({ status: null });
    expect(String((none as Error).message)).not.toContain(KEY);
  });
});

describe("mailer settings", () => {
  it("needs BREVO_API_KEY and EMAIL_FROM together", () => {
    expect(() => loadConfig({ ...BASE, BREVO_API_KEY: KEY })).toThrow(/EMAIL_FROM/);
    expect(() => loadConfig({ ...BASE, EMAIL_FROM: "codes@example.com" })).toThrow(/BREVO_API_KEY/);
    const config = loadConfig({ ...BASE, BREVO_API_KEY: KEY, EMAIL_FROM: "codes@example.com" });
    expect(config.EMAIL_FROM_NAME).toBe("HostelConnect");
    expect(mailerFromConfig(config)).not.toBeNull();
  });

  it("is off without settings, and prints to the console only outside production", () => {
    expect(mailerFromConfig(loadConfig(BASE))).toBeNull();
    expect(mailerFromConfig(loadConfig({ ...BASE, EMAIL_CONSOLE: "true" }))).not.toBeNull();
    expect(() =>
      loadConfig({
        ...BASE,
        NODE_ENV: "production",
        EMAIL_CONSOLE: "true",
        SUPABASE_URL: "https://abcd.supabase.co",
        SUPABASE_SECRET_KEY: "s".repeat(30),
        JOB_SECRET: "j".repeat(32),
      }),
    ).toThrow(/EMAIL_CONSOLE/);
  });

  it("never prints the key in a configuration error", () => {
    try {
      loadConfig({ ...BASE, BREVO_API_KEY: KEY });
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });
});

describe("consoleMailer and maskEmail", () => {
  it("prints the email for local development", async () => {
    const lines: string[] = [];
    await consoleMailer((l) => lines.push(l)).send({ to: "o@b.co", subject: "Code", text: "123456" });
    expect(lines.join("\n")).toContain("123456");
  });

  it("shows only the start of the address", () => {
    expect(maskEmail("nikhil@gmail.com")).toBe("ni•••@gmail.com");
    expect(maskEmail("a@b.co")).toBe("a•••@b.co");
    expect(maskEmail("broken")).toBe("•••");
  });
});
