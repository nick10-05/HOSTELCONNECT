import type { Config } from "../config";

// Email for the server, so far only the codes that allow deleting a building or room
// (services/structureDeletion.ts). Sent through Brevo's HTTP API with plain fetch, no SDK,
// as storage.ts does for Supabase: an HTTPS request works on hosts that block outgoing
// SMTP. Nothing here logs, and no error carries the API key, the address or the text.

export type Email = { to: string; subject: string; text: string };

// What the rest of the server needs. Tests pass a fake with the same shape.
export interface Mailer {
  send(email: Email): Promise<void>;
}

// The email service refused or did not answer. `status` is the HTTP status, or null when
// no answer came (network failure or the time limit).
export class MailError extends Error {
  constructor(readonly status: number | null) {
    super(`Email could not be sent (${status === null ? "no answer" : `status ${status}`})`);
    this.name = "MailError";
  }
}

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
// A code expires in 5 minutes; the owner should hear about a failure long before.
const TIME_LIMIT_MS = 10_000;

type BrevoOptions = {
  apiKey: string;
  from: string; // a sender address verified in Brevo
  fromName: string;
  fetch?: typeof globalThis.fetch; // tests pass a fake
};

export function brevoMailer({ apiKey, from, fromName, fetch = globalThis.fetch }: BrevoOptions): Mailer {
  return {
    async send({ to, subject, text }) {
      let res: Response;
      try {
        res = await fetch(BREVO_SEND_URL, {
          method: "POST",
          headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ sender: { email: from, name: fromName }, to: [{ email: to }], subject, textContent: text }),
          signal: AbortSignal.timeout(TIME_LIMIT_MS),
        });
      } catch {
        // The original error is dropped: its text could repeat what was sent.
        throw new MailError(null);
      }
      // Brevo answers 201 with a message id; anything else is a refusal.
      if (!res.ok) throw new MailError(res.status);
    },
  };
}

// Local development only (EMAIL_CONSOLE=true, refused in production by config.ts): the
// email is printed to the server's own terminal instead of being sent.
export function consoleMailer(log: (line: string) => void = console.log): Mailer {
  return {
    async send({ to, subject, text }) {
      log(`[email to ${to}] ${subject}\n${text}`);
    },
  };
}

// Brevo when BREVO_API_KEY and EMAIL_FROM are set, the console in development when asked,
// otherwise none: then deleting buildings and rooms is off (it needs a code).
export function mailerFromConfig(config: Config): Mailer | null {
  if (config.BREVO_API_KEY && config.EMAIL_FROM) {
    return brevoMailer({ apiKey: config.BREVO_API_KEY, from: config.EMAIL_FROM, fromName: config.EMAIL_FROM_NAME });
  }
  if (config.EMAIL_CONSOLE) return consoleMailer();
  return null;
}

// 'nikhil@gmail.com' -> 'ni•••@gmail.com': enough for the owner to recognise the inbox,
// not the whole address on screen.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}
