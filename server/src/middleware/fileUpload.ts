import type { RequestHandler } from "express";
import multer from "multer";
import { sendError } from "../lib/http";

export type FileUploadOptions = {
  // The one file's form field name.
  field: string;
  maxBytes: number;
  // How many text fields may come with it.
  fields: number;
  // The 413 answer's code and what the message calls the file: "The photo".
  tooLarge: { code: string; what: string };
  // The 400 answer's message for a second file, a file under another name or too many fields.
  usage: string;
};

// Reads optional multipart form data with at most one file, held in memory (never written
// to disk), and the text fields beside it (day 8, shared since day 9). A request that is
// not multipart (JSON) passes through untouched. The file's type is not checked here: the
// route reads it from the bytes (detectPhotoType).
//
// Refusals, before anything is stored:
//   413 tooLarge.code    "<what> can be at most <limit>."
//   400 invalid_input    a second file, a file under another name, too many fields
//                        (`usage`), or form data that cannot be read
export function singleFileUpload(o: FileUploadOptions): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: o.maxBytes,
      files: 1,
      fields: o.fields,
      // 8 KB is far more than any of our text fields hold in any script.
      fieldSize: 8 * 1024,
      parts: o.fields + 1,
    },
  }).single(o.field);

  return (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return sendError(res, 413, o.tooLarge.code, `${o.tooLarge.what} can be at most ${sizeText(o.maxBytes)}.`);
      }
      if (err instanceof multer.MulterError) {
        return sendError(res, 400, "invalid_input", o.usage);
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
