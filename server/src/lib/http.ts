import type { Request, Response } from "express";
import type { z } from "zod";

// Every error answer has this shape (design doc, section 5).
export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

// Thrown by service functions for an expected refusal (not found, already exists, in
// use). Services know nothing about Express; errorHandler turns this into the normal
// error answer. Anything else thrown is a bug and becomes a 500.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Validates the request body. On failure it answers 400 and returns undefined, so a
// route reads: `const body = parseBody(schema, req, res); if (!body) return;`
// The message names fields and problems only, never the submitted values.
export function parseBody<T extends z.ZodType>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
  sendError(res, 400, "invalid_input", problems);
  return undefined;
}
