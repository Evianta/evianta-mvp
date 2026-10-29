import { createHash, randomUUID } from "node:crypto";
import type { UsageContext } from "@evianta/ai";
import {
  ExtractedDocumentSchema,
  type DocumentMetadataRecord,
  type DocumentRepository,
  type DocumentState,
  type DocumentStore,
  type ExtractedDocument,
  type ExtractedPage,
  type ExtractionCacheIdentity,
  type ExtractionMethod,
  type ExtractionRepository,
  type ExtractionWarning,
  type OwnerScope,
} from "@evianta/core";
import {
  extractorVersionFor,
  resolveIngestionSettings,
  type IngestionOptions,
  type IngestionSettings,
} from "./config.js";
import {
  detectFormat,
  isImageFormat,
  mayNeedOcr,
  type DocumentFormat,
} from "./detect.js";
import { IngestionError } from "./errors.js";
import { imageFrames } from "./image.js";
import type { OcrBackend } from "./ocr.js";
import { openPdf, type OpenedPdf } from "./pdf.js";
import { parseDelimited, parseJson, parseWorkbook } from "./tabular.js";

export const incompleteWarningCode = "extraction-incomplete";
export const pageNotExtractedWarningCode = "page-not-extracted";
export const lowConfidenceWarningCode = "low-ocr-confidence";
export const handwritingWarningCode = "handwriting-needs-review";
const reviewWarningCodes = new Set([
  incompleteWarningCode,
  pageNotExtractedWarningCode,
  lowConfidenceWarningCode,
  handwritingWarningCode,
  "empty-ocr-text",
]);

export type OcrStopReason =
  | "usage-limit"
  | "interrupted"
  | "ocr-unavailable"
  | "ocr-unsupported"
  | "usage-context-required"
  | "ocr-page-limit"
  | "claim-lost"
  | "ocr-failed";

export interface DocumentIngestionDependencies {
  documents: DocumentRepository;
  extractions: ExtractionRepository;
  storage: DocumentStore;
  /** Null disables OCR; scanned pages then stop in a partial state. */
  ocr: OcrBackend | null;
  options?: IngestionOptions;
  now?: () => Date;
}

export interface IngestDocumentRequest {
  scope: OwnerScope;
  documentId: string;
  /** Required before any OCR call so the attempt is admitted and accounted. */
  usageContext?: UsageContext;
  signal?: AbortSignal;
  holderId?: string;
}

export interface IngestionResult {
  status: "ready" | "partial" | "in-progress";
  extraction: ExtractedDocument | null;
  cached: boolean;
  /** Page indexes OCR was attempted on during this call, including failed attempts. */
  ocrPages: number[];
  stopReason: OcrStopReason | null;
}

export interface DocumentIngestion {
  readonly extractorVersion: string;
  ingest(request: IngestDocumentRequest): Promise<IngestionResult>;
}

/** True when an extraction carries flags that need a human before use. */
export function requiresReview(extraction: ExtractedDocument): boolean {
  return extraction.warnings.some((warning) =>
    reviewWarningCodes.has(warning.code),
  );
}

export function isIncomplete(extraction: ExtractedDocument): boolean {
  return extraction.warnings.some(
    (warning) => warning.code === incompleteWarningCode,
  );
}

interface VisualPage {
  index: number;
  width: number | null;
  height: number | null;
  text: string | null;
  spans: ExtractedPage["spans"];
  load: () => Promise<{ mimeType: string; bytes: Uint8Array }>;
}

const limitErrorCodes = new Set([
  "usage-admission-rejected",
  "spend-limit-exceeded",
  "run-concurrency-limit",
  "run-admission-required",
  "stale-run-admission",
  "admission-expired",
]);

function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function classifyOcrError(
  error: unknown,
  signal: AbortSignal | undefined,
): OcrStopReason {
  if (signal?.aborted) return "interrupted";
  const code = errorCode(error);
  if (code && limitErrorCodes.has(code)) return "usage-limit";
  if (
    code === "unsupported-capability" ||
    code === "unbounded-usage-capability"
  ) {
    return "ocr-unsupported";
  }
  if (error instanceof Error && error.name === "AbortError")
    return "interrupted";
  return "ocr-failed";
}

const stopMessages: Record<OcrStopReason, string> = {
  "usage-limit": "OCR stopped because a usage limit was reached",
  interrupted: "OCR was interrupted before all pages were extracted",
  "ocr-unavailable": "No OCR backend is configured for scanned pages",
  "ocr-unsupported": "The configured model cannot read images",
  "usage-context-required": "OCR requires an admitted usage context",
  "ocr-page-limit": "The document has more scanned pages than the OCR limit",
  "claim-lost": "Another worker took over this extraction",
  "ocr-failed": "The OCR request failed",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function documentMethod(pages: readonly ExtractedPage[]): ExtractionMethod {
  const methods = new Set(pages.map((page) => page.method));
  if (methods.size === 1) return [...methods][0];
  return methods.size === 0 ? "parse" : "mixed";
}

export function createDocumentIngestion(
  dependencies: DocumentIngestionDependencies,
): DocumentIngestion {
  const settings: IngestionSettings = resolveIngestionSettings(
    dependencies.options,
  );
  const { limits } = settings;
  const extractorVersion = extractorVersionFor(settings);
  const now = dependencies.now ?? (() => new Date());

  async function loadBytes(
    record: DocumentMetadataRecord,
  ): Promise<Uint8Array> {
    if (record.sizeBytes > limits.maxBytes) {
      throw new IngestionError(
        "Document exceeds the ingestion size limit",
        "size-limit-exceeded",
      );
    }
    let bytes: Uint8Array | null;
    try {
      // The object key always comes from the owned document record, never the caller.
      bytes = await dependencies.storage.readBufferAsync(
        record.objectKey,
        limits.maxBytes,
      );
    } catch (error) {
      if (errorCode(error) === "too-large") {
        throw new IngestionError(
          "Document exceeds the ingestion size limit",
          "size-limit-exceeded",
          { cause: error },
        );
      }
      throw new IngestionError(
        "Document bytes could not be read",
        "document-bytes-missing",
        { cause: error },
      );
    }
    if (!bytes)
      throw new IngestionError(
        "Document bytes are missing",
        "document-bytes-missing",
      );
    if (sha256(bytes) !== record.contentHash.toLowerCase()) {
      throw new IngestionError(
        "Document bytes do not match the recorded hash",
        "content-hash-mismatch",
      );
    }
    return bytes;
  }

  function parseOnly(format: DocumentFormat, bytes: Uint8Array) {
    const text = () => new TextDecoder("utf-8").decode(bytes);
    switch (format) {
      case "csv":
      case "tsv":
        return {
          kind: "tabular" as const,
          pages: [],
          ...parseDelimited(text(), format === "csv" ? "," : "\t", limits),
        };
      case "xlsx":
      case "xls":
        return {
          kind: "tabular" as const,
          pages: [],
          ...parseWorkbook(bytes, limits, format === "xlsx"),
        };
      case "json": {
        const parsed = parseJson(text(), limits);
        if (parsed.kind === "tabular")
          return {
            kind: "tabular" as const,
            pages: [],
            tables: parsed.tables,
            warnings: [],
          };
        return {
          kind: "text" as const,
          pages: [textPage(parsed.text)],
          tables: [],
          warnings: [],
        };
      }
      case "text":
        return {
          kind: "text" as const,
          pages: [textPage(text().replace(/^\uFEFF/, ""))],
          tables: [],
          warnings: [],
        };
      default:
        return null;
    }
  }

  function textPage(text: string): ExtractedPage {
    return {
      index: 0,
      text,
      width: null,
      height: null,
      method: "parse",
      confidence: 1,
      spans: [],
    };
  }

  async function visualPages(
    format: DocumentFormat,
    bytes: Uint8Array,
    pdf: OpenedPdf | null,
  ): Promise<VisualPage[]> {
    if (pdf) {
      const pages: VisualPage[] = [];
      for (let index = 0; index < pdf.pageCount; index += 1) {
        const page = await pdf.page(index);
        const usable =
          page.text.replace(/\s/g, "").length >= settings.minTextLayerChars;
        pages.push({
          ...page,
          text: usable ? page.text : null,
          spans: usable ? page.spans : [],
        });
      }
      return pages;
    }
    if (!isImageFormat(format))
      throw new IngestionError(
        "Document format is not supported",
        "unsupported-format",
      );
    return imageFrames(bytes, format, limits).map((frame, index) => ({
      index,
      width: frame.width,
      height: frame.height,
      text: null,
      spans: [],
      load: frame.load,
    }));
  }

  return {
    extractorVersion,
    async ingest(request) {
      const { scope } = request;
      let record = await dependencies.documents.findOwned(
        request.documentId,
        scope,
      );
      if (!record) {
        throw new IngestionError(
          "Document was not found in this case",
          "document-not-found",
        );
      }
      if (
        request.usageContext &&
        (request.usageContext.userId !== scope.ownerId ||
          (request.usageContext.caseId !== undefined &&
            request.usageContext.caseId !== scope.caseId))
      ) {
        throw new IngestionError(
          "Usage context does not match the document scope",
          "usage-context-mismatch",
        );
      }

      const setState = async (state: DocumentState) => {
        if (!record || record.state === state) return;
        const next: DocumentMetadataRecord = {
          ...record,
          state,
          processedAt:
            state === "processing" ? record.processedAt : now().toISOString(),
        };
        if (await dependencies.documents.replaceOwned(next, scope))
          record = next;
      };
      const fail = async (error: unknown): Promise<never> => {
        await setState("failed");
        throw error;
      };

      let bytes: Uint8Array;
      let format: DocumentFormat;
      try {
        bytes = await loadBytes(record);
        format = detectFormat(bytes, record.mimeType, record.name, limits);
      } catch (error) {
        return fail(error);
      }

      const cacheIdentity: ExtractionCacheIdentity = {
        contentHash: record.contentHash.toLowerCase(),
        extractorVersion,
        modelVersion: mayNeedOcr(format)
          ? (dependencies.ocr?.version ?? "none")
          : null,
      };
      const cached = await dependencies.extractions.findCached(
        record.id,
        cacheIdentity,
        scope,
      );
      if (cached && !isIncomplete(cached)) {
        await setState("ready");
        return {
          status: "ready",
          extraction: cached,
          cached: true,
          ocrPages: [],
          stopReason: null,
        };
      }

      const holderId = request.holderId ?? randomUUID();
      const claimRequest = () => {
        const at = now();
        return {
          documentId: record!.id,
          cacheIdentity,
          holderId,
          at: at.toISOString(),
          expiresAt: new Date(
            at.getTime() + settings.claimTtlSeconds * 1000,
          ).toISOString(),
        };
      };
      if (!(await dependencies.extractions.claim(claimRequest(), scope))) {
        return {
          status: "in-progress",
          extraction: cached,
          cached: false,
          ocrPages: [],
          stopReason: null,
        };
      }

      let pdf: OpenedPdf | null = null;
      try {
        await setState("processing");
        const parsed = (() => {
          try {
            return parseOnly(format, bytes);
          } catch (error) {
            return error instanceof IngestionError
              ? error
              : new IngestionError(
                  "Document could not be parsed",
                  "parse-failed",
                  { cause: error },
                );
          }
        })();
        if (parsed instanceof IngestionError) return await fail(parsed);
        if (parsed) {
          const extraction = ExtractedDocumentSchema.parse({
            documentId: record.id,
            kind: parsed.kind,
            method: "parse",
            confidence: 1,
            pages: parsed.pages,
            tables: parsed.tables,
            warnings: parsed.warnings,
            cacheIdentity,
          });
          await dependencies.extractions.saveForDocument(extraction, scope);
          await setState("ready");
          return {
            status: "ready",
            extraction,
            cached: false,
            ocrPages: [],
            stopReason: null,
          };
        }

        let pages: VisualPage[];
        try {
          if (format === "pdf") pdf = await openPdf(bytes, limits);
          pages = await visualPages(format, bytes, pdf);
        } catch (error) {
          return await fail(
            error instanceof IngestionError
              ? error
              : new IngestionError(
                  "Document could not be parsed",
                  "parse-failed",
                  { cause: error },
                ),
          );
        }

        const previous = new Map<number, ExtractedPage>();
        if (cached) {
          const missing = new Set(
            cached.warnings
              .filter((warning) => warning.code === pageNotExtractedWarningCode)
              .map((warning) => warning.pageIndex),
          );
          for (const page of cached.pages)
            if (!missing.has(page.index)) previous.set(page.index, page);
        }

        const extracted: ExtractedPage[] = [];
        const warnings: ExtractionWarning[] = [];
        const ocrPages: number[] = [];
        let stopReason: OcrStopReason | null = null;
        let ocrBudget = limits.maxOcrPages;

        const placeholder = (
          page: VisualPage,
          reason: OcrStopReason | "page-render-failed",
          message: string,
        ) => {
          extracted.push({
            index: page.index,
            text: "",
            width: page.width,
            height: page.height,
            method: "ocr",
            confidence: 0,
            spans: [],
          });
          warnings.push({
            code: pageNotExtractedWarningCode,
            message: `${reason}: ${message}`,
            pageIndex: page.index,
          });
        };

        for (const page of pages) {
          if (page.text !== null) {
            extracted.push({
              index: page.index,
              text: page.text,
              width: page.width,
              height: page.height,
              method: "pdf-text",
              confidence: 1,
              spans: page.spans,
            });
            continue;
          }
          const reused = previous.get(page.index);
          if (reused) {
            extracted.push(reused);
            warnings.push(...ocrWarnings(reused));
            continue;
          }
          if (!stopReason) {
            if (!dependencies.ocr) stopReason = "ocr-unavailable";
            else if (!request.usageContext)
              stopReason = "usage-context-required";
            else if (request.signal?.aborted) stopReason = "interrupted";
            else if (ocrBudget < 1) stopReason = "ocr-page-limit";
            else if (
              !(await dependencies.extractions.claim(claimRequest(), scope))
            )
              stopReason = "claim-lost";
          }
          if (stopReason) {
            placeholder(page, stopReason, stopMessages[stopReason]);
            continue;
          }
          let image;
          try {
            image = await page.load();
          } catch (error) {
            placeholder(
              page,
              "page-render-failed",
              error instanceof Error
                ? error.message
                : "Page could not be rendered",
            );
            continue;
          }
          ocrBudget -= 1;
          ocrPages.push(page.index);
          try {
            const result = await dependencies.ocr!.extractPage({
              pageIndex: page.index,
              pageCount: pages.length,
              image,
              usageContext: request.usageContext!,
              signal: request.signal,
            });
            const confidence =
              result.method === "handwriting"
                ? Math.min(result.confidence, settings.handwritingConfidenceCap)
                : result.confidence;
            const output: ExtractedPage = {
              index: page.index,
              text: result.text,
              width: page.width,
              height: page.height,
              method: result.method,
              confidence,
              spans: result.spans,
            };
            extracted.push(output);
            warnings.push(...ocrWarnings(output));
          } catch (error) {
            stopReason = classifyOcrError(error, request.signal);
            placeholder(
              page,
              stopReason,
              `${stopMessages[stopReason]}${errorCode(error) ? ` (${errorCode(error)})` : ""}`,
            );
          }
        }

        const incomplete = warnings.some(
          (warning) => warning.code === pageNotExtractedWarningCode,
        );
        if (incomplete) {
          warnings.unshift({
            code: incompleteWarningCode,
            message: stopReason
              ? stopMessages[stopReason]
              : "Some pages could not be extracted",
            pageIndex: null,
          });
        }
        const extraction = ExtractedDocumentSchema.parse({
          documentId: record.id,
          kind: "text",
          method: documentMethod(extracted),
          confidence: extracted.length
            ? Math.min(...extracted.map((page) => page.confidence))
            : 0,
          pages: extracted,
          tables: [],
          warnings,
          cacheIdentity,
        });
        await dependencies.extractions.saveForDocument(extraction, scope);
        await setState(incomplete ? "partial" : "ready");
        return {
          status: incomplete ? "partial" : "ready",
          extraction,
          cached: false,
          ocrPages,
          stopReason,
        };
      } finally {
        await pdf?.close();
        await dependencies.extractions.releaseClaim(
          { documentId: record.id, cacheIdentity, holderId },
          scope,
        );
      }
    },
  };

  function ocrWarnings(page: ExtractedPage): ExtractionWarning[] {
    const warnings: ExtractionWarning[] = [];
    if (page.method === "handwriting") {
      warnings.push({
        code: handwritingWarningCode,
        message: "Handwritten content must be verified by a person before use",
        pageIndex: page.index,
      });
    }
    if (page.confidence < settings.lowConfidenceThreshold) {
      warnings.push({
        code: lowConfidenceWarningCode,
        message: `OCR confidence ${page.confidence.toFixed(2)} is below ${settings.lowConfidenceThreshold}`,
        pageIndex: page.index,
      });
    }
    if (page.text.trim() === "") {
      warnings.push({
        code: "empty-ocr-text",
        message: "OCR returned no text for this page",
        pageIndex: page.index,
      });
    }
    return warnings;
  }
}
