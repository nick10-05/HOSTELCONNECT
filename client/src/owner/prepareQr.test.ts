import { describe, expect, it } from "vitest";
import type { PhotoCodec } from "../student/compressPhoto";
import { prepareQr, QrError } from "./prepareQr";

// The server's limit, written out rather than imported, so a wrong constant cannot hide.
const QR_MAX_BYTES = 200 * 1024;

// A fake codec, as in compressPhoto.test.ts: "decodes" any file to the given size and
// "encodes" a JPEG whose bytes grow with the pixels and the quality.
function fakeCodec(size: { width: number; height: number }, bytesPerPixel = 0.5) {
  const qualities: number[] = [];
  const codec: PhotoCodec = {
    decode: async () => ({ ...size, close: () => undefined }),
    encode: async (_image, width, height, quality) => {
      qualities.push(quality);
      return new Blob([new Uint8Array(Math.round(width * height * quality * bytesPerPixel))], { type: "image/jpeg" });
    },
  };
  return { codec, qualities };
}

const file = (type: string, bytes: number) => new File([new Uint8Array(bytes)], "qr", { type });

describe("prepareQr", () => {
  it("sends a JPEG, PNG or WebP of 200 KB or less exactly as it is, to keep it sharp", async () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      const { codec, qualities } = fakeCodec({ width: 1000, height: 1000 });
      const small = file(type, QR_MAX_BYTES);
      expect(await prepareQr(small, codec)).toBe(small);
      expect(qualities).toEqual([]);
    }
  });

  it("shrinks a larger image to 200 KB or less", async () => {
    const { codec, qualities } = fakeCodec({ width: 1000, height: 1000 });
    const out = await prepareQr(file("image/png", QR_MAX_BYTES + 1), codec);
    expect(out.size).toBeLessThanOrEqual(QR_MAX_BYTES);
    expect(out.type).toBe("image/jpeg");
    // 500 KB would have been reached at the first quality; 200 KB needs more steps.
    expect(qualities.length).toBeGreaterThan(1);
  });

  it("converts another picture type, such as a GIF, whatever its size", async () => {
    const { codec } = fakeCodec({ width: 300, height: 300 });
    const out = await prepareQr(file("image/gif", 1000), codec);
    expect(out.type).toBe("image/jpeg");
  });

  it("refuses a file that is not a picture", async () => {
    const { codec } = fakeCodec({ width: 300, height: 300 });
    await expect(prepareQr(file("application/pdf", 1000), codec)).rejects.toEqual(
      new QrError("Choose a picture of the QR code (JPEG, PNG or WebP)."),
    );
  });

  it("refuses an image that cannot be read or made small enough", async () => {
    const huge = fakeCodec({ width: 1000, height: 1000 }, 50);
    await expect(prepareQr(file("image/png", 5_000_000), huge.codec)).rejects.toEqual(
      new QrError("This picture could not be made small enough. Try a screenshot of just the QR code."),
    );
    // The best it can do is about 300 KB: a complaint photo could be that size, a QR cannot.
    const almost = fakeCodec({ width: 1000, height: 1000 }, 4.2);
    await expect(prepareQr(file("image/png", 5_000_000), almost.codec)).rejects.toEqual(
      new QrError("This picture could not be made small enough. Try a screenshot of just the QR code."),
    );
    const broken: PhotoCodec = {
      decode: async () => {
        throw new Error("cannot decode");
      },
      encode: async () => new Blob([]),
    };
    await expect(prepareQr(file("image/png", 5_000_000), broken)).rejects.toEqual(
      new QrError("This picture could not be made small enough. Try a screenshot of just the QR code."),
    );
  });
});
