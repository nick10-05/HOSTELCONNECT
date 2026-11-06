import type { PhotoType } from "./storage";

// A photo's type from its first bytes (its "magic number"), never from its file name or
// the type the browser claims, which anyone can set (design doc, section 8). Only the
// three types the server stores; anything else, SVG and HEIC included, is null.
export function detectPhotoType(bytes: Uint8Array): PhotoType | null {
  const starts = (offset: number, signature: number[]) =>
    bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
  const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

  if (starts(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(0, [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF, then 4 bytes of length, then WEBP.
  if (starts(0, ascii("RIFF")) && starts(8, ascii("WEBP"))) return "image/webp";
  return null;
}
