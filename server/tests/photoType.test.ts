import { describe, expect, it } from "vitest";
import { detectPhotoType } from "../src/lib/photoType";

// The server decides a photo's type from its first bytes, never from its name or the
// type the browser claims (section 8: "checked by file content and not just extension").
const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((v) => (typeof v === "string" ? [...v].map((ch) => ch.charCodeAt(0)) : [v])));

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, "JFIF", 0x00);
const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, "IHDR");
const WEBP = bytes("RIFF", 0x24, 0x00, 0x00, 0x00, "WEBP", "VP8 ");

describe("detectPhotoType", () => {
  it("recognises JPEG, PNG and WebP by their first bytes", () => {
    expect(detectPhotoType(JPEG)).toBe("image/jpeg");
    expect(detectPhotoType(PNG)).toBe("image/png");
    expect(detectPhotoType(WEBP)).toBe("image/webp");
  });

  it("refuses everything else, however it is named", () => {
    for (const [label, content] of [
      ["empty", bytes()],
      ["GIF", bytes("GIF89a", 0x01, 0x00, 0x01, 0x00)],
      ["PDF", bytes("%PDF-1.7\n")],
      ["SVG (can carry script)", bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
      ["HTML", bytes("<!doctype html><script>")],
      ["HEIC", bytes(0x00, 0x00, 0x00, 0x18, "ftypheic")],
      ["a RIFF file that is not WebP (WAV)", bytes("RIFF", 0x24, 0x00, 0x00, 0x00, "WAVE", "fmt ")],
      ["the start of a JPEG only", bytes(0xff, 0xd8)],
      ["the start of a PNG only", bytes(0x89, "PNG", 0x0d, 0x0a)],
      ["RIFF without the rest", bytes("RIFF", 0x24, 0x00, 0x00, 0x00, "WEB")],
      ["a JPEG signature not at the start", bytes(0x00, 0xff, 0xd8, 0xff, 0xe0)],
    ] as const) {
      expect(detectPhotoType(content), label).toBeNull();
    }
  });
});
