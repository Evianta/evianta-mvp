import type { ImageInput } from "@evianta/ai";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import UTIF from "utif2";
import type { IngestionLimits } from "./config.js";
import type { ImageFormat } from "./detect.js";
import { IngestionError } from "./errors.js";

/** Formats and payload size the vision adapters accept without conversion. */
const visionMimeTypes: Partial<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const maxVisionBytes = 8 * 1024 * 1024;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageFrame extends ImageSize {
  load: () => Promise<ImageInput>;
}

function readSize(
  bytes: Uint8Array,
  format: Exclude<ImageFormat, "tiff">,
): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fits = (length: number) => bytes.length >= length;
  switch (format) {
    case "png":
      return fits(24)
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : null;
    case "gif":
      return fits(10)
        ? { width: view.getUint16(6, true), height: view.getUint16(8, true) }
        : null;
    case "bmp":
      return fits(26)
        ? {
            width: Math.abs(view.getInt32(18, true)),
            height: Math.abs(view.getInt32(22, true)),
          }
        : null;
    case "webp": {
      if (!fits(30)) return null;
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X") {
        const read24 = (offset: number) =>
          bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
        return { width: read24(24) + 1, height: read24(27) + 1 };
      }
      if (chunk === "VP8L") {
        const bits = view.getUint32(21, true);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      if (chunk === "VP8 ") {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
      return null;
    }
    case "jpeg": {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        if (
          marker === 0xd8 ||
          (marker >= 0xd0 && marker <= 0xd7) ||
          marker === 0x01
        ) {
          offset += 2;
          continue;
        }
        const length = view.getUint16(offset + 2);
        const isFrame =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isFrame) {
          return {
            width: view.getUint16(offset + 7),
            height: view.getUint16(offset + 5),
          };
        }
        offset += 2 + length;
      }
      return null;
    }
  }
}

function assertPixels(size: ImageSize, limits: IngestionLimits): void {
  if (!(size.width > 0 && size.height > 0)) {
    throw new IngestionError(
      "Image dimensions could not be read",
      "parse-failed",
    );
  }
  if (size.width * size.height > limits.maxImagePixels) {
    throw new IngestionError(
      "Image exceeds the decoded pixel limit",
      "image-limit-exceeded",
    );
  }
}

export function boundedScale(
  size: ImageSize,
  limits: IngestionLimits,
  preferred = 1,
): number {
  const longest = Math.max(size.width, size.height);
  const byDimension = limits.maxRenderDimension / longest;
  const byPixels = Math.sqrt(
    limits.maxImagePixels / (size.width * size.height),
  );
  return Math.min(preferred, byDimension, byPixels);
}

export async function encodeCanvas(canvas: Canvas): Promise<ImageInput> {
  const png = await canvas.encode("png");
  if (png.byteLength <= maxVisionBytes)
    return { mimeType: "image/png", bytes: new Uint8Array(png) };
  const jpeg = await canvas.encode("jpeg", 85);
  if (jpeg.byteLength <= maxVisionBytes)
    return { mimeType: "image/jpeg", bytes: new Uint8Array(jpeg) };
  throw new IngestionError(
    "Normalized image is too large for the vision model",
    "image-limit-exceeded",
  );
}

function whiteCanvas(width: number, height: number): Canvas {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  return canvas;
}

async function rasterize(
  bytes: Uint8Array,
  size: ImageSize,
  limits: IngestionLimits,
): Promise<ImageInput> {
  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch (error) {
    throw new IngestionError("Image could not be decoded", "parse-failed", {
      cause: error,
    });
  }
  const scale = boundedScale(size, limits);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const canvas = whiteCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return encodeCanvas(canvas);
}

/**
 * Splits an image into frames (multi-page TIFFs yield several) and converts
 * each into a bounded PNG/JPEG/WebP the vision adapter accepts. Dimensions
 * are checked from headers before any pixels are decoded.
 */
export function imageFrames(
  bytes: Uint8Array,
  format: ImageFormat,
  limits: IngestionLimits,
): ImageFrame[] {
  if (format === "tiff") return tiffFrames(bytes, limits);
  const size = readSize(bytes, format);
  if (!size)
    throw new IngestionError(
      "Image dimensions could not be read",
      "parse-failed",
    );
  assertPixels(size, limits);
  const mimeType = visionMimeTypes[format];
  const passThrough =
    mimeType !== undefined &&
    bytes.byteLength <= maxVisionBytes &&
    Math.max(size.width, size.height) <= limits.maxRenderDimension;
  return [
    {
      ...size,
      load: async () =>
        passThrough ? { mimeType, bytes } : rasterize(bytes, size, limits),
    },
  ];
}

function tagNumber(value: unknown): number {
  const first =
    Array.isArray(value) || ArrayBuffer.isView(value)
      ? (value as ArrayLike<unknown>)[0]
      : value;
  return Number(first);
}

function tiffFrames(bytes: Uint8Array, limits: IngestionLimits): ImageFrame[] {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  let directories: UTIF.IFD[];
  try {
    directories = UTIF.decode(buffer).filter(
      (directory) => directory.t256 && directory.t257,
    );
  } catch (error) {
    throw new IngestionError("TIFF could not be parsed", "parse-failed", {
      cause: error,
    });
  }
  if (directories.length === 0)
    throw new IngestionError("TIFF has no images", "parse-failed");
  if (directories.length > limits.maxPages) {
    throw new IngestionError("TIFF has too many pages", "page-limit-exceeded");
  }
  return directories.map((directory) => {
    const size = {
      width: tagNumber(directory.t256),
      height: tagNumber(directory.t257),
    };
    assertPixels(size, limits);
    return {
      ...size,
      load: async () => {
        let rgba: Uint8Array;
        try {
          UTIF.decodeImage(buffer, directory);
          rgba = UTIF.toRGBA8(directory);
        } catch (error) {
          throw new IngestionError(
            "TIFF page could not be decoded",
            "parse-failed",
            { cause: error },
          );
        } finally {
          Reflect.deleteProperty(directory, "data");
        }
        const source = createCanvas(size.width, size.height);
        const context = source.getContext("2d");
        const data = context.createImageData(size.width, size.height);
        data.data.set(rgba.subarray(0, data.data.length));
        context.putImageData(data, 0, 0);
        const scale = boundedScale(size, limits);
        const width = Math.max(1, Math.round(size.width * scale));
        const height = Math.max(1, Math.round(size.height * scale));
        const canvas = whiteCanvas(width, height);
        canvas.getContext("2d").drawImage(source, 0, 0, width, height);
        return encodeCanvas(canvas);
      },
    };
  });
}
