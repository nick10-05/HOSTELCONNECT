import type { ErrorRequestHandler, RequestHandler } from "express";
import { sendError } from "../lib/http";

// Any /api path no route matched.
export const apiNotFound: RequestHandler = (_req, res) => {
  sendError(res, 404, "not_found", "No such endpoint");
};

// Last middleware. Express 5 sends thrown errors and rejected promises here.
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  // Errors raised by express.json() for a broken or oversized body.
  const type = (err as { type?: string }).type;
  if (type === "entity.parse.failed") {
    sendError(res, 400, "invalid_json", "Request body is not valid JSON");
    return;
  }
  if (type === "entity.too.large") {
    sendError(res, 413, "payload_too_large", "Request body is too large");
    return;
  }
  // Log the details for us; the client only learns that something failed.
  console.error(err);
  sendError(res, 500, "internal", "Something went wrong");
};
