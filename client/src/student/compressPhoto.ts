// Shrinks a complaint photo in the browser before it is sent (design doc, section 8: "the
// browser compresses to about 500 KB"; the server refuses anything over 1 MB). Day 8.
//
// The photo is decoded the right way up (phones store the rotation separately), its longer
// side limited to MAX_SIDE pixels, and drawn onto a white canvas (a transparent PNG would
// otherwise turn black) saved as JPEG. The quality steps down from 0.8 to 0.4; if even 0.4
// is over TARGET_BYTES, the picture shrinks by a quarter and the qualities are tried again,
// down to MIN_SIDE pixels. The smallest result that fits under the server's cap is kept
// rather than refusing a detailed photo. Redrawing also leaves out the photo's hidden
// details (EXIF), such as the GPS position where it was taken.

export const MAX_SIDE = 1600;
export const MIN_SIDE = 400;
export const TARGET_BYTES = 500 * 1024;
// The server's PHOTO_MAX_BYTES default.
export const UPLOAD_MAX_BYTES = 1024 * 1024;
// Larger files are refused before decoding: a huge picture can exhaust a phone's memory.
export const INPUT_MAX_BYTES = 30 * 1024 * 1024;
const QUALITIES = [0.8, 0.7, 0.6, 0.5, 0.4];

// A message for the student, shown as-is.
export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoError";
  }
}

export type DecodedImage = { width: number; height: number; close(): void };

// The canvas work, passed in so tests can replace it (jsdom has no canvas).
export type PhotoCodec = {
  decode(file: Blob): Promise<DecodedImage>;
  encode(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob>;
};

// The size that fits within maxSide on the longer side, keeping the shape; never larger
// than the original, never under 1 pixel.
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function compressPhoto(file: File, codec: PhotoCodec = canvasCodec): Promise<Blob> {
  // Some phones give no type at all; decoding then decides.
  if (file.type !== "" && !file.type.startsWith("image/")) {
    throw new PhotoError("Choose a photo (JPEG, PNG or WebP).");
  }
  if (file.size > INPUT_MAX_BYTES) {
    throw new PhotoError("This photo is too large. Choose one under 30 MB.");
  }

  let image: DecodedImage;
  try {
    image = await codec.decode(file);
  } catch {
    throw new PhotoError("This photo could not be read. Try a JPEG or PNG photo.");
  }

  try {
    let smallest: Blob | null = null;
    let side = MAX_SIDE;
    for (;;) {
      const { width, height } = fitWithin(image.width, image.height, side);
      for (const quality of QUALITIES) {
        const blob = await codec.encode(image, width, height, quality);
        if (blob.size <= TARGET_BYTES) return blob;
        if (!smallest || blob.size < smallest.size) smallest = blob;
      }
      // The next size down, measured from what was just tried (a small photo starts below MAX_SIDE).
      const next = Math.round(Math.max(width, height) * 0.75);
      if (next < MIN_SIDE) break;
      side = next;
    }
    if (smallest && smallest.size <= UPLOAD_MAX_BYTES) return smallest;
    throw new PhotoError("This photo is too large even after shrinking. Try another photo.");
  } finally {
    image.close();
  }
}

// The browser's own decoder and canvas: no library.
const canvasCodec: PhotoCodec = {
  decode: (file) => createImageBitmap(file, { imageOrientation: "from-image" }),
  encode: (image, width, height, quality) =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return reject(new PhotoError("This browser cannot prepare photos. Send the complaint without one."));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image as ImageBitmap, 0, 0, width, height);
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new PhotoError("This photo could not be prepared. Try another photo.")),
        "image/jpeg",
        quality,
      );
    }),
};
