import type { RequestHandler } from "express";
import { singleFileUpload } from "./fileUpload";

// Reads a complaint's optional photo from multipart form data (day 8): at most one file,
// named "photo", with the text fields category and description beside it. JSON passes
// through untouched. Used on POST /api/complaints only.
//
// Refusals, before anything is stored (fileUpload.ts):
//   413 photo_too_large   "The photo can be at most <limit>."
//   400 invalid_input     a second file, a file under another name, too many fields,
//                         or form data that cannot be read
// The type is not checked here: the route reads it from the bytes (detectPhotoType).
export function photoUpload(maxBytes: number): RequestHandler {
  return singleFileUpload({
    field: "photo",
    maxBytes,
    fields: 2,
    tooLarge: { code: "photo_too_large", what: "The photo" },
    usage: "photo: send at most one file, named photo, with category and description",
  });
}
