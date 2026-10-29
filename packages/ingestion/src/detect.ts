import type { IngestionLimits } from "./config.js";
import { IngestionError } from "./errors.js";

export type DocumentFormat =
  | "pdf"
  | "png"
  | "jpeg"
  | "webp"
  | "gif"
  | "bmp"
  | "tiff"
  | "xlsx"
  | "xls"
  | "csv"
  | "tsv"
  | "json"
  | "text";

export type ImageFormat = "png" | "jpeg" | "webp" | "gif" | "bmp" | "tiff";

const imageFormats: ReadonlySet<DocumentFormat> = new Set([
  "png",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tiff",
]);

export function isImageFormat(format: DocumentFormat): format is ImageFormat {
  return imageFormats.has(format);
}

/** Formats whose content may need the multimodal model. */
export function mayNeedOcr(format: DocumentFormat): boolean {
  return format === "pdf" || isImageFormat(format);
}

const genericMimeTypes = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "",
]);

const binaryMimeTypes: Record<string, readonly string[]> = {
  pdf: ["application/pdf", "application/x-pdf"],
  png: ["image/png"],
  jpeg: ["image/jpeg", "image/jpg", "image/pjpeg"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  bmp: ["image/bmp", "image/x-bmp", "image/x-ms-bmp"],
  tiff: ["image/tiff", "image/tif"],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
    "application/x-zip-compressed",
  ],
  xls: ["application/vnd.ms-excel", "application/x-ole-storage"],
};

const textMimeTypes: Record<string, DocumentFormat> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/x-csv": "csv",
  // Windows browsers commonly report CSV uploads as Excel.
  "application/vnd.ms-excel": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/json": "json",
};

const extensionFormats: Record<string, DocumentFormat> = {
  csv: "csv",
  tsv: "tsv",
  tab: "tsv",
  json: "json",
  txt: "text",
  text: "text",
};

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

type BinarySignature =
  | Exclude<DocumentFormat, "xlsx" | "xls" | "csv" | "tsv" | "json" | "text">
  | "zip"
  | "cfb";

function sniffBinary(bytes: Uint8Array): BinarySignature | null {
  // PDF readers accept a header within the first kilobyte.
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024));
  if (head.includes("%PDF-")) return "pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP")
    return "webp";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 2) === "BM" && bytes.length > 26) return "bmp";
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return "tiff";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return "cfb";
  return null;
}

export interface ZipInventory {
  names: string[];
  uncompressedBytes: number;
}

/**
 * Reads the zip central directory without inflating anything so archive
 * bombs are rejected before a spreadsheet parser touches them.
 */
export function inspectZip(
  bytes: Uint8Array,
  limits: IngestionLimits,
): ZipInventory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEnd = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimumEnd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) {
    throw new IngestionError(
      "Spreadsheet archive is malformed",
      "parse-failed",
    );
  }
  const entries = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entries === 0xffff || directoryOffset === 0xffffffff) {
    throw new IngestionError(
      "ZIP64 spreadsheet archives are not supported",
      "decompression-limit-exceeded",
    );
  }
  if (entries > limits.maxZipEntries) {
    throw new IngestionError(
      "Spreadsheet archive has too many entries",
      "decompression-limit-exceeded",
    );
  }
  const names: string[] = [];
  let uncompressedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw new IngestionError(
        "Spreadsheet archive is malformed",
        "parse-failed",
      );
    }
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (size === 0xffffffff) {
      throw new IngestionError(
        "ZIP64 spreadsheet archives are not supported",
        "decompression-limit-exceeded",
      );
    }
    uncompressedBytes += size;
    if (uncompressedBytes > limits.maxDecompressedBytes) {
      throw new IngestionError(
        "Spreadsheet archive expands beyond the allowed size",
        "decompression-limit-exceeded",
      );
    }
    names.push(
      new TextDecoder().decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      ),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names, uncompressedBytes };
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      sample.length === bytes.length ? sample : trimPartialUtf8(sample),
    );
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(sample: Uint8Array): Uint8Array {
  let end = sample.length;
  // Drop up to three continuation bytes left over from a truncated sample.
  for (
    let count = 0;
    count < 3 && end > 0 && (sample[end - 1] & 0xc0) === 0x80;
    count += 1
  ) {
    end -= 1;
  }
  if (end > 0 && sample[end - 1] >= 0xc0) end -= 1;
  return sample.subarray(0, end);
}

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function mismatch(declared: string): never {
  throw new IngestionError(
    `File content does not match its declared type ${declared}`,
    "content-type-mismatch",
  );
}

/**
 * Chooses a format from the bytes first and only uses the declared MIME type
 * and file name to disambiguate text formats, so a renamed file cannot pick
 * a different parser.
 */
export function detectFormat(
  bytes: Uint8Array,
  declaredMimeType: string,
  name: string,
  limits: IngestionLimits,
): DocumentFormat {
  if (bytes.length === 0) {
    throw new IngestionError("Document is empty", "unsupported-format");
  }
  const declared = declaredMimeType.split(";")[0].trim().toLowerCase();
  const generic = genericMimeTypes.has(declared);
  const sniffed = sniffBinary(bytes);

  if (sniffed) {
    let format: DocumentFormat;
    if (sniffed === "zip") {
      const inventory = inspectZip(bytes, limits);
      if (!inventory.names.includes("xl/workbook.xml")) {
        throw new IngestionError(
          "Archive is not a supported spreadsheet",
          "unsupported-format",
        );
      }
      format = "xlsx";
    } else if (sniffed === "cfb") {
      format = "xls";
    } else {
      format = sniffed;
    }
    if (!generic && !binaryMimeTypes[format].includes(declared))
      mismatch(declared);
    return format;
  }

  if (!looksLikeText(bytes)) {
    throw new IngestionError(
      "Document format is not supported",
      "unsupported-format",
    );
  }
  const fromMime = textMimeTypes[declared];
  if (fromMime) return fromMime;
  if (declared === "text/plain" || generic) {
    return extensionFormats[extensionOf(name)] ?? "text";
  }
  if (declared.startsWith("text/")) return "text";
  return mismatch(declared);
}
