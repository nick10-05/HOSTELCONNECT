import { QR_MAX_BYTES } from "../api/settings";
import { compressPhoto, type PhotoCodec } from "../student/compressPhoto";

// Gets the owner's QR picture ready to upload (day 9; design doc, section 3: at most 200
// KB, compressed by the browser). A JPEG, PNG or WebP of 200 KB or less is sent exactly as
// it is: recompressing would only blur the code. Anything else, larger or another picture
// type, is redrawn as a JPEG of 200 KB or less by the complaint photo's compressPhoto.

// A message for the owner, shown as is.
export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrError";
  }
}

const SENT_AS_IS = ["image/jpeg", "image/png", "image/webp"];

export async function prepareQr(file: File, codec?: PhotoCodec): Promise<Blob> {
  // Some phones give no type at all; decoding then decides.
  if (file.type !== "" && !file.type.startsWith("image/")) {
    throw new QrError("Choose a picture of the QR code (JPEG, PNG or WebP).");
  }
  if (SENT_AS_IS.includes(file.type) && file.size <= QR_MAX_BYTES) return file;
  try {
    return await compressPhoto(file, codec, { targetBytes: QR_MAX_BYTES, uploadMaxBytes: QR_MAX_BYTES });
  } catch {
    // compressPhoto's own messages speak of complaint photos.
    throw new QrError("This picture could not be made small enough. Try a screenshot of just the QR code.");
  }
}
