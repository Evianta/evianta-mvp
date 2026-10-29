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
  if (/^%PDF-\d\.\d(?:\r|\n)/.test(ascii(bytes, 0, 10))) return "pdf";
  return null;
}

export interface ZipInventory {
  names: string[];
  uncompressedBytes: number;
}

/**
 * Validates both ZIP directories and bounds actual inflation before handing
 * the archive to a parser with its own decompressor.
 */
export function inspectZip(
  bytes: Uint8Array,
  limits: IngestionLimits,
): ZipInventory {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const malformed = (): never => {
    throw new IngestionError(
      "Spreadsheet archive is malformed",
      "parse-failed",
    );
  };
  const minimumEnd = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimumEnd; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
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
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== entries ||
    directoryOffset + directorySize !== end
  )
    malformed();
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
  const localRanges: { start: number; end: number }[] = [];
  let uncompressedBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new IngestionError(
        "Spreadsheet archive is malformed",
        "parse-failed",
      );
    }
    const size = view.getUint32(offset + 24, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const checksum = view.getUint32(offset + 16, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
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
    if (
      offset + 46 + nameLength + extraLength + commentLength > end ||
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50 ||
      flags & ~0x080e ||
      (method !== 0 && method !== 8) ||
      view.getUint16(localOffset + 6, true) !== flags ||
      view.getUint16(localOffset + 8, true) !== method
    )
      malformed();
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    let dataEnd = dataStart + compressedSize;
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes);
    if (
      localNameLength !== nameLength ||
      dataEnd > directoryOffset ||
      !Buffer.from(nameBytes).equals(
        bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
      ) ||
      names.includes(name)
    )
      malformed();
    const descriptor = Boolean(flags & 8);
    for (const [field, expected] of [
      [14, checksum],
      [18, compressedSize],
      [22, size],
    ]) {
      const actual = view.getUint32(localOffset + field, true);
      if (actual !== expected && !(descriptor && actual === 0)) malformed();
    }
    if (descriptor) {
      if (dataEnd + 12 > directoryOffset) malformed();
      if (view.getUint32(dataEnd, true) === 0x08074b50) dataEnd += 4;
      if (
        dataEnd + 12 > directoryOffset ||
        view.getUint32(dataEnd, true) !== checksum ||
        view.getUint32(dataEnd + 4, true) !== compressedSize ||
        view.getUint32(dataEnd + 8, true) !== size
      )
        malformed();
      dataEnd += 12;
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let inflated: Uint8Array;
    try {
      inflated =
        method === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.min(size, limits.maxDecompressedBytes) + 1,
            });
    } catch (error) {
      throw new IngestionError(
        "Spreadsheet archive could not be inflated within its size bound",
        "decompression-limit-exceeded",
        { cause: error },
      );
    }
    if (inflated.length !== size) {
      throw new IngestionError(
        "Spreadsheet archive size does not match its contents",
        "decompression-limit-exceeded",
      );
    }
    if (crc32(inflated) !== checksum) malformed();
    localRanges.push({ start: localOffset, end: dataEnd });
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) malformed();
  let localEnd = 0;
  for (const range of localRanges.sort((a, b) => a.start - b.start)) {
    if (range.start !== localEnd) malformed();
    localEnd = range.end;
  }
  if (localEnd !== directoryOffset) malformed();
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
import { crc32, inflateRawSync } from "node:zlib";
