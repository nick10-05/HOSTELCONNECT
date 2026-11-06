import { describe, expect, it } from "vitest";
import {
  compressPhoto,
  fitWithin,
  MAX_SIDE,
  PhotoError,
  TARGET_BYTES,
  UPLOAD_MAX_BYTES,
  type PhotoCodec,
} from "./compressPhoto";

// The canvas work is passed in, so these tests need no real canvas (jsdom has none): a
// fake codec "decodes" any file to the size it is told, and "encodes" a JPEG whose bytes
// grow with the pixels and the quality, like a real one.
type Encoded = { width: number; height: number; quality: number };

function fakeCodec(size: { width: number; height: number }, bytesPerPixel = 0.5) {
  const encoded: Encoded[] = [];
  let closed = 0;
  const codec: PhotoCodec = {
    decode: async () => ({ ...size, close: () => void (closed += 1) }),
    encode: async (_image, width, height, quality) => {
      encoded.push({ width, height, quality });
      return new Blob([new Uint8Array(Math.round(width * height * quality * bytesPerPixel))], { type: "image/jpeg" });
    },
  };
  return { codec, encoded, closedCount: () => closed };
}

const photo = (type = "image/jpeg", bytes = 3_000_000) => new File([new Uint8Array(bytes)], "IMG_1234.jpg", { type });

describe("fitWithin", () => {
  it("shrinks the longer side to the limit, keeping the shape", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(4032, 1960, 1600)).toEqual({ width: 1600, height: 778 });
  });

  it("never enlarges a small photo, and never gives a side under 1 pixel", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10_000, 2, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe("compressPhoto", () => {
  it("makes a phone photo a JPEG of at most 1600 pixels and about 500 KB", async () => {
    const { codec, encoded, closedCount } = fakeCodec({ width: 4000, height: 3000 });
    const out = await compressPhoto(photo(), codec);
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBeLessThanOrEqual(TARGET_BYTES);
    expect(encoded[0]).toEqual({ width: MAX_SIDE, height: 1200, quality: 0.8 });
    // The decoded image is let go once done.
    expect(closedCount()).toBe(1);
  });

  it("lowers the quality step by step until the photo is small enough", async () => {
    // 1600 x 1200 at 0.8 is 768,000 bytes; 0.6 is 576,000; 0.5 is 480,000.
    const { codec, encoded } = fakeCodec({ width: 4000, height: 3000 });
    const out = await compressPhoto(photo(), codec);
    expect(encoded.map((e) => e.quality)).toEqual([0.8, 0.7, 0.6, 0.5]);
    expect(out.size).toBe(480_000);
  });

  it("shrinks the picture further when the lowest quality is still too big", async () => {
    // A very detailed photo: 2 bytes per pixel. At 0.4 and 1600 x 1200 it is 1.5 MB.
    const { codec, encoded } = fakeCodec({ width: 4000, height: 3000 }, 2);
    const out = await compressPhoto(photo(), codec);
    expect(out.size).toBeLessThanOrEqual(TARGET_BYTES);
    expect(Math.min(...encoded.map((e) => e.quality))).toBeGreaterThanOrEqual(0.4);
    const last = encoded[encoded.length - 1];
    expect(last.width).toBeLessThan(MAX_SIDE);
    expect(last.width / last.height).toBeCloseTo(4 / 3, 1);
  });

  it("keeps a photo that only fits under the server's 1 MB cap, rather than ruin it", async () => {
    // Encodes to 600 KB whatever the quality or size: over the target, under the cap.
    const encoded: number[] = [];
    const codec: PhotoCodec = {
      decode: async () => ({ width: 1000, height: 1000, close: () => {} }),
      encode: async (_i, width) => {
        encoded.push(width);
        return new Blob([new Uint8Array(600 * 1024)], { type: "image/jpeg" });
      },
    };
    const out = await compressPhoto(photo(), codec);
    expect(out.size).toBe(600 * 1024);
    expect(Math.min(...encoded)).toBeGreaterThanOrEqual(400);
  });

  it("refuses a photo that cannot get under the server's cap", async () => {
    const codec: PhotoCodec = {
      decode: async () => ({ width: 1000, height: 1000, close: () => {} }),
      encode: async () => new Blob([new Uint8Array(UPLOAD_MAX_BYTES + 1)], { type: "image/jpeg" }),
    };
    await expect(compressPhoto(photo(), codec)).rejects.toThrow(
      new PhotoError("This photo is too large even after shrinking. Try another photo."),
    );
  });

  it("refuses a file that is not a picture, or one the browser cannot read", async () => {
    const { codec } = fakeCodec({ width: 100, height: 100 });
    await expect(compressPhoto(photo("application/pdf"), codec)).rejects.toThrow(
      new PhotoError("Choose a photo (JPEG, PNG or WebP)."),
    );
    const unreadable: PhotoCodec = {
      ...codec,
      decode: async () => {
        throw new Error("decode failed");
      },
    };
    await expect(compressPhoto(photo("image/heic"), unreadable)).rejects.toThrow(
      new PhotoError("This photo could not be read. Try a JPEG or PNG photo."),
    );
  });

  it("refuses a picture too large to open safely before decoding it", async () => {
    const { codec, encoded } = fakeCodec({ width: 100, height: 100 });
    await expect(compressPhoto(photo("image/jpeg", 30 * 1024 * 1024 + 1), codec)).rejects.toThrow(
      new PhotoError("This photo is too large. Choose one under 30 MB."),
    );
    expect(encoded).toEqual([]);
  });
});
