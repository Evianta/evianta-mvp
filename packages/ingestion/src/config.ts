import { createHash } from "node:crypto";

export const EXTRACTOR_VERSION = "ingestion-3";

export interface IngestionLimits {
  /** Largest stored object the pipeline will read. */
  maxBytes: number;
  /** Largest PDF page count or multi-page image frame count. */
  maxPages: number;
  /** Most pages one ingestion may send to OCR before stopping as partial. */
  maxOcrPages: number;
  /** Decoded pixel bound for images, PDF images and rendered pages. */
  maxImagePixels: number;
  /** Longest edge of an image sent to the vision model. */
  maxRenderDimension: number;
  maxRows: number;
  maxColumns: number;
  maxTableCells: number;
  maxSheets: number;
  /** Uncompressed byte bound for zip-based spreadsheets. */
  maxDecompressedBytes: number;
  maxZipEntries: number;
  /** BSON output bound, leaving room for persistence metadata below 16 MiB. */
  maxExtractedBytes: number;
  parserTimeoutMs: number;
}

export interface IngestionSettings {
  limits: IngestionLimits;
  /** OCR pages below this confidence are flagged for review. */
  lowConfidenceThreshold: number;
  /** Handwriting confidence is capped so it never reads as trusted. */
  handwritingConfidenceCap: number;
  /** Non-whitespace characters a PDF page needs to count as a text layer. */
  minTextLayerChars: number;
  claimTtlSeconds: number;
}

export interface IngestionOptions {
  limits?: Partial<IngestionLimits>;
  lowConfidenceThreshold?: number;
  handwritingConfidenceCap?: number;
  minTextLayerChars?: number;
  claimTtlSeconds?: number;
}

export const defaultIngestionLimits: IngestionLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxPages: 100,
  maxOcrPages: 25,
  maxImagePixels: 40_000_000,
  maxRenderDimension: 2_000,
  maxRows: 100_000,
  maxColumns: 500,
  maxTableCells: 250_000,
  maxSheets: 25,
  maxDecompressedBytes: 200 * 1024 * 1024,
  maxZipEntries: 2_000,
  maxExtractedBytes: 12 * 1024 * 1024,
  parserTimeoutMs: 20_000,
};

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function unitInterval(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

export function resolveIngestionSettings(
  options: IngestionOptions = {},
): IngestionSettings {
  const limits = { ...defaultIngestionLimits, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    positiveInteger(name, value);
  }
  if (limits.maxExtractedBytes > 15 * 1024 * 1024) {
    throw new Error("maxExtractedBytes must not exceed 15 MiB");
  }
  return {
    limits,
    lowConfidenceThreshold: unitInterval(
      "lowConfidenceThreshold",
      options.lowConfidenceThreshold ?? 0.75,
    ),
    handwritingConfidenceCap: unitInterval(
      "handwritingConfidenceCap",
      options.handwritingConfidenceCap ?? 0.6,
    ),
    minTextLayerChars: positiveInteger(
      "minTextLayerChars",
      options.minTextLayerChars ?? 10,
    ),
    claimTtlSeconds: positiveInteger(
      "claimTtlSeconds",
      options.claimTtlSeconds ?? 900,
    ),
  };
}

/**
 * Cache identity for the extractor configuration. Settings that change the
 * extracted output are hashed in, so changing them invalidates cached results.
 */
export function extractorVersionFor(settings: IngestionSettings): string {
  const { claimTtlSeconds, ...outputSettings } = settings;
  void claimTtlSeconds;
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        outputSettings,
        Object.keys(flatten(outputSettings)).sort(),
      ),
    )
    .digest("hex")
    .slice(0, 16);
  return `${EXTRACTOR_VERSION}:${digest}`;
}

function flatten(
  value: object,
  into: Record<string, true> = {},
): Record<string, true> {
  for (const [key, item] of Object.entries(value)) {
    into[key] = true;
    if (item && typeof item === "object") flatten(item, into);
  }
  return into;
}
