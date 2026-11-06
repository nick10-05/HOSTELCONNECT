import type { RequestHandler } from "express";
import multer from "multer";
import { sendError } from "../lib/http";

// Reads a complaint's optional photo from multipart form data (day 8): at most one file,
// named "photo", held in memory (never written to disk), with the text fields beside it.
// A request that is not multipart (JSON) passes through untouched. Used on
// POST /api/complaints only, so no other route accepts files.
//
// Refusals, before anything is stored:
//   413 photo_too_large   "The photo can be at most <limit>."
//   400 invalid_input     a second file, a file under another name, too many fields,
//                         or form data that cannot be read
// The type is not checked here: the route reads it from the bytes (detectPhotoType).
export function photoUpload(maxBytes: number): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      // category and description; 8 KB is far more than 500 characters of any script.
      fields: 2,
      fieldSize: 8 * 1024,
      parts: 3,
    },
  }).single("photo");

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return sendError(res, 413, "photo_too_large", `The photo can be at most ${sizeText(maxBytes)}.`);
      }
      if (err instanceof multer.MulterError) {
        return sendError(res, 400, "invalid_input", "photo: send at most one file, named photo, with category and description");
      }
      // Broken form data (cut off, bad boundary): the parser's message names no values.
      sendError(res, 400, "invalid_input", "The form data could not be read");
    });
  };
}

// 1048576 -> "1 MB", 2048 -> "2 KB".
function sizeText(bytes: number): string {
  const MB = 1024 * 1024;
  return bytes % MB === 0 ? `${bytes / MB} MB` : `${Math.round(bytes / 1024)} KB`;
}
