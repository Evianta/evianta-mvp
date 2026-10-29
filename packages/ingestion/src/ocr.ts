import type {
  AiClient,
  ImageInput,
  ModelTier,
  UsageContext,
} from "@evianta/ai";
import type { PositionedSpan } from "@evianta/core";

export interface OcrPageRequest {
  pageIndex: number;
  pageCount: number;
  image: ImageInput;
  usageContext: UsageContext;
  signal?: AbortSignal;
}

export interface OcrPageResult {
  text: string;
  method: "ocr" | "handwriting";
  /** Uncalibrated model signal, not a probability of correctness. */
  confidence: number;
  /** Approximate line boxes; empty when the backend cannot provide them. */
  spans: PositionedSpan[];
}

/**
 * Replaceable OCR boundary so a specialist backend can be added later
 * without touching ingestion callers or agents.
 */
export interface OcrBackend {
  /** Changes whenever the model or request shape changes; part of the cache key. */
  readonly version: string;
  extractPage(request: OcrPageRequest): Promise<OcrPageResult>;
}

export interface MuseOcrBackendOptions {
  ai: AiClient;
  /** Configured model ID behind the tier, used for cache invalidation. */
  modelVersion: string;
  tier?: Exclude<ModelTier, "high">;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export function createMuseOcrBackend(
  options: MuseOcrBackendOptions,
): OcrBackend {
  const tier = options.tier ?? "cheap";
  const maxOutputTokens = options.maxOutputTokens ?? 2_048;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("OCR maxOutputTokens must be a positive integer");
  }
  return {
    version: `muse-ocr-1:${tier}:${options.modelVersion}:${maxOutputTokens}`,
    async extractPage(request) {
      const result = await options.ai.extractMultimodal({
        tier,
        system: "",
        // Only page position is sent; document text is never treated as instructions.
        input: { page: request.pageIndex + 1, pageCount: request.pageCount },
        images: [request.image],
        usageContext: request.usageContext,
        signal: request.signal,
        maxOutputTokens,
        timeoutMs: options.timeoutMs,
      });
      return {
        text: result.output.text,
        method: result.output.method,
        confidence: result.output.confidence,
        spans: [],
      };
    },
  };
}
