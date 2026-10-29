import { randomUUID } from "node:crypto";
import { z as zod, type ZodType } from "zod";
import type { UsageUnits } from "@evianta/core";

export type ModelTier = "cheap" | "mid" | "high";
export type ModelProviderName = "muse" | "mock";
export type ModelCapability =
  | "structured-json"
  | "vision"
  | "streaming"
  | "tools"
  | "web-search";

export interface ModelConfiguration {
  provider: ModelProviderName;
  model: string;
  reasoning?: string;
  maxOutputTokens: number;
  maxInputTokens: number;
  pricingIdentity: string;
  pricingSettings: Record<string, string | number | boolean | null>;
  capabilities: readonly ModelCapability[];
}

export interface ModelSettings {
  provider: ModelProviderName;
  sparkModel?: string;
  wonderModel?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  pricingSettings?: Record<string, string | number | boolean | null>;
  capabilitiesByTier?: Partial<Record<ModelTier, readonly ModelCapability[]>>;
}

const allModelCapabilities: readonly ModelCapability[] = [
  "structured-json",
  "vision",
  "streaming",
  "tools",
  "web-search",
];

export function modelForTier(
  tier: ModelTier,
  settings: ModelSettings,
): ModelConfiguration {
  const isWonder = tier === "high";
  const model = isWonder ? settings.wonderModel : settings.sparkModel;

  if (!model) {
    throw new Error(
      `${isWonder ? "Wonder" : "Spark"} model ID is not configured`,
    );
  }

  const maxOutputTokens = settings.maxOutputTokens ?? 2048;

  return {
    provider: settings.provider,
    model,
    maxOutputTokens,
    maxInputTokens: settings.maxInputTokens ?? 32_000,
    pricingIdentity: `${settings.provider}:${model}`,
    pricingSettings: {
      ...settings.pricingSettings,
      maxOutputTokens,
    },
    capabilities:
      settings.capabilitiesByTier?.[tier] ??
      (settings.provider === "mock"
        ? allModelCapabilities
        : ["structured-json", "streaming"]),
  };
}

export interface UsageContext {
  userId: string;
  caseId?: string;
  runId?: string;
  leaseId?: string;
  fencingToken?: number;
  taskId?: string;
}

export interface UsageAttempt {
  attemptId: string;
  context: UsageContext;
  provider: ModelProviderName;
  model: string;
  settings: Record<string, string | number | boolean | null>;
  maxInputTokens: number;
  maxOutputTokens: number;
  searchRequested: boolean;
  outcome: "success" | "failed" | "unknown";
  units: UsageUnits;
  errorCode?: string;
}

export interface UsageAccounting {
  mode?: "test" | "admitted";
  admit(
    attempt: Omit<UsageAttempt, "outcome" | "units" | "errorCode">,
  ): Promise<AbortSignal | undefined>;
  record(attempt: UsageAttempt): Promise<CostEstimate | void>;
  cancel(attemptId: string): Promise<void>;
}

export interface Citation {
  url: string;
  title: string;
  claim?: string;
  span?: string;
}

export interface ProviderResult {
  text: string;
  units: UsageUnits;
  citations: Citation[];
}

export interface StructuredGenerationRequest {
  model: ModelConfiguration;
  system: string;
  input: unknown;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
  images?: readonly ImageInput[];
  webSearch?: boolean;
}

export interface ImageInput {
  mimeType: string;
  bytes: Uint8Array;
}

export interface ModelProvider {
  readonly providerName: ModelProviderName;
  generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<ProviderResult>;
  streamText(request: {
    model: ModelConfiguration;
    system: string;
    input: unknown;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<string>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedCapabilityError extends AiError {
  constructor(capability: ModelCapability) {
    super(
      `The selected model does not support ${capability}`,
      "unsupported-capability",
    );
  }
}

export class ProviderRequestError extends AiError {
  constructor(
    message: string,
    readonly statusCode: number | undefined,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message, "provider-request-failed");
  }
}

export class ProviderRefusalError extends AiError {
  constructor(readonly units?: UsageUnits) {
    super("The model refused the request", "provider-refusal");
  }
}

export class ProviderTruncationError extends AiError {
  constructor(readonly units?: UsageUnits) {
    super("The model response was truncated", "provider-truncated");
  }
}

export class OutputValidationError extends AiError {
  constructor() {
    super(
      "The model response did not match the requested schema",
      "invalid-model-output",
    );
  }
}

export class AdmissionRejectedError extends AiError {
  constructor(message = "Usage admission was rejected") {
    super(message, "usage-admission-rejected");
  }
}

export interface AiClientOptions {
  provider: ModelProvider;
  accounting: UsageAccounting;
  models: ModelSettings;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface RunStructuredRequest<I, O> {
  tier: ModelTier;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  system: string;
  input: I;
  usageContext: UsageContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  images?: readonly ImageInput[];
  webSearch?: boolean;
}

export interface CostEstimate {
  status: "estimated" | "unknown";
  costUsd: number | null;
  pricingIdentity: string;
}

export interface RunStructuredResult<O> {
  output: O;
  usage: UsageUnits;
  cost: CostEstimate;
  citations: Citation[];
  provider: ModelProviderName;
  model: string;
}

export interface AiClient {
  runStructured<I, O>(
    request: RunStructuredRequest<I, O>,
  ): Promise<RunStructuredResult<O>>;
  streamText(
    request: Omit<
      RunStructuredRequest<unknown, never>,
      "inputSchema" | "outputSchema" | "images" | "webSearch"
    >,
  ): AsyncIterable<string>;
  extractMultimodal(
    request: Omit<
      RunStructuredRequest<unknown, TranscriptionResult>,
      "inputSchema" | "outputSchema"
    >,
  ): Promise<RunStructuredResult<TranscriptionResult>>;
}

export interface TranscriptionResult {
  text: string;
  method: "ocr" | "handwriting";
  confidence: number;
}

const transcriptionSchema = zod.object({
  text: zod.string(),
  method: zod.enum(["ocr", "handwriting"]),
  confidence: zod.number().min(0).max(1),
});

const unknownUsage = (): UsageUnits => ({
  input: null,
  output: null,
  total: null,
  reasoning: null,
  cacheRead: null,
  cacheWrite: null,
  search: null,
});

function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Model request timed out")),
    timeoutMs,
  );
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abort, { once: true });

  if (callerSignal?.aborted) abort();

  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abort);
    },
  };
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const listeners = activeSignals.map((signal) => {
    const listener = () => abort(signal);
    if (signal.aborted) {
      abort(signal);
    } else {
      signal.addEventListener("abort", listener, { once: true });
    }
    return { signal, listener };
  });
  return {
    signal: controller.signal,
    clear: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function isRetryable(error: unknown): error is ProviderRequestError {
  return (
    error instanceof ProviderRequestError &&
    (error.statusCode === 429 ||
      (error.statusCode !== undefined &&
        error.statusCode >= 500 &&
        error.statusCode <= 599))
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateImages(images: readonly ImageInput[] | undefined): void {
  if (!images) return;
  if (images.length > 20) {
    throw new AiError(
      "A request may contain at most 20 images",
      "invalid-image-input",
    );
  }
  for (const image of images) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)) {
      throw new AiError("Unsupported image MIME type", "invalid-image-input");
    }
    if (
      image.bytes.byteLength === 0 ||
      image.bytes.byteLength > 10 * 1024 * 1024
    ) {
      throw new AiError(
        "Image must be between 1 byte and 10 MiB",
        "invalid-image-input",
      );
    }
  }
}

function inputTokenAllowance(input: {
  system: string;
  input: unknown;
  schema?: Record<string, unknown>;
  images?: readonly ImageInput[];
}): number {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      system: input.system,
      input: input.input,
      schema: input.schema,
    });
  } catch {
    throw new AiError(
      "The model input cannot be serialized for usage admission",
      "invalid-model-input",
    );
  }
  const bytes =
    Buffer.byteLength(serialized ?? "", "utf8") +
    (input.images ?? []).reduce(
      (total, image) => total + image.bytes.byteLength,
      0,
    );
  return Math.ceil(bytes * 1.5) + 256;
}

function validateWebSearchQuery(input: unknown): void {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.trim().length > 500
  ) {
    throw new AiError(
      "Web-search input must be an explicit query of at most 500 characters",
      "invalid-web-search-query",
    );
  }
}

export function createAi(options: AiClientOptions): AiClient {
  if (options.provider.providerName !== options.models.provider) {
    throw new AdmissionRejectedError(
      "The configured model provider does not match the injected provider adapter",
    );
  }
  if (
    options.models.provider === "muse" &&
    (options.accounting.mode !== "admitted" ||
      !Number.isInteger(options.models.maxInputTokens) ||
      (options.models.maxInputTokens ?? 0) < 1 ||
      !Number.isInteger(options.models.maxOutputTokens) ||
      (options.models.maxOutputTokens ?? 0) < 1)
  ) {
    throw new AdmissionRejectedError(
      "Paid models require durable accounting and explicit input/output limits",
    );
  }
  const defaultTimeout = options.timeoutMs ?? 60_000;

  async function runStructured<I, O>(
    request: RunStructuredRequest<I, O>,
  ): Promise<RunStructuredResult<O>> {
    const input = request.inputSchema.parse(request.input);
    const model = modelForTier(request.tier, options.models);
    if (request.images?.length && !model.capabilities.includes("vision")) {
      throw new UnsupportedCapabilityError("vision");
    }
    if (request.webSearch && !model.capabilities.includes("web-search")) {
      throw new UnsupportedCapabilityError("web-search");
    }
    if (request.webSearch && request.images?.length) {
      throw new AiError(
        "Web search cannot be combined with image inputs",
        "unsupported-request-combination",
      );
    }
    validateImages(request.images);
    if (request.webSearch) validateWebSearchQuery(input);
    if (
      options.accounting.mode === "admitted" &&
      model.provider === "muse" &&
      request.webSearch
    ) {
      throw new AiError(
        "Paid web search is disabled until provider search usage can be bounded",
        "unbounded-usage-capability",
      );
    }
    if (
      options.accounting.mode === "admitted" &&
      model.provider === "muse" &&
      request.images?.length
    ) {
      throw new AiError(
        "Paid image requests are disabled until provider image usage can be bounded",
        "unbounded-usage-capability",
      );
    }

    const requestedOutputTokens =
      request.maxOutputTokens ??
      options.maxOutputTokens ??
      model.maxOutputTokens;
    if (!Number.isInteger(requestedOutputTokens) || requestedOutputTokens < 1) {
      throw new Error("maxOutputTokens must be a positive integer");
    }
    const maxOutputTokens = Math.min(
      requestedOutputTokens,
      model.maxOutputTokens,
    );
    const dispatchedModel: ModelConfiguration = {
      ...model,
      maxOutputTokens,
      pricingSettings: {
        ...model.pricingSettings,
        maxOutputTokens,
      },
    };
    const schema = zod.toJSONSchema(request.outputSchema) as Record<
      string,
      unknown
    >;
    const timeout = combineSignals(
      request.signal,
      request.timeoutMs ?? defaultTimeout,
    );
    const structuredInput = input;
    let correction: string | undefined;
    let correctionUsed = false;
    let lastValidationError: OutputValidationError | undefined;

    try {
      for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
        const attemptId = randomUUID();
        const system = correction
          ? `${request.system}\n\n${correction}`
          : request.system;
        const usageAttempt = {
          attemptId,
          context: request.usageContext,
          provider: dispatchedModel.provider,
          model: dispatchedModel.model,
          settings: dispatchedModel.pricingSettings,
          maxInputTokens: inputTokenAllowance({
            system,
            input: structuredInput,
            schema,
            images: request.images,
          }),
          maxOutputTokens,
          searchRequested: Boolean(request.webSearch),
        };
        if (usageAttempt.maxInputTokens > model.maxInputTokens) {
          throw new AiError(
            "The model input exceeds the configured token limit",
            "input-limit-exceeded",
          );
        }
        if (timeout.signal.aborted) throw timeout.signal.reason;
        const admissionSignal = await options.accounting.admit(usageAttempt);
        if (timeout.signal.aborted || admissionSignal?.aborted) {
          await options.accounting.cancel(attemptId);
          throw (
            timeout.signal.reason ??
            admissionSignal?.reason ??
            new Error("Model request was cancelled before dispatch")
          );
        }
        const providerSignals = combineAbortSignals([
          timeout.signal,
          admissionSignal,
        ]);
        try {
          let result: ProviderResult;
          try {
            result = await options.provider.generateStructured({
              model: dispatchedModel,
              system,
              input: structuredInput,
              schema,
              maxOutputTokens,
              signal: providerSignals.signal,
              images: request.images,
              webSearch: request.webSearch,
            });
          } catch (error) {
            const retryable = isRetryable(error);
            await options.accounting.record({
              ...usageAttempt,
              outcome:
                (error instanceof ProviderRequestError &&
                  error.statusCode === 429) ||
                error instanceof ProviderRefusalError ||
                error instanceof ProviderTruncationError
                  ? "failed"
                  : "unknown",
              units:
                error instanceof ProviderRefusalError ||
                error instanceof ProviderTruncationError
                  ? (error.units ?? unknownUsage())
                  : unknownUsage(),
              errorCode:
                error instanceof AiError ? error.code : "provider-unknown",
            });

            if (!retryable || attemptNumber === 2) throw error;
            const waitMs =
              error.retryAfterMs ??
              250 * 2 ** attemptNumber + Math.random() * 150;
            await delay(waitMs, timeout.signal);
            continue;
          }

          let output: O;
          try {
            output = request.outputSchema.parse(JSON.parse(result.text));
          } catch {
            lastValidationError = new OutputValidationError();
            await options.accounting.record({
              ...usageAttempt,
              outcome: "failed",
              units: result.units,
              errorCode: lastValidationError.code,
            });
            if (correctionUsed || attemptNumber === 2)
              throw lastValidationError;
            correctionUsed = true;
            correction =
              "Your previous response was invalid. Return only valid JSON matching the requested schema.";
            continue;
          }

          const cost = await options.accounting.record({
            ...usageAttempt,
            outcome: "success",
            units: result.units,
          });
          return {
            output,
            usage: result.units,
            cost: cost ?? {
              status: "unknown",
              costUsd: null,
              pricingIdentity: model.pricingIdentity,
            },
            citations: result.citations,
            provider: model.provider,
            model: model.model,
          };
        } finally {
          providerSignals.clear();
        }
      }

      throw lastValidationError ?? new Error("Model call did not complete");
    } finally {
      timeout.clear();
    }
  }

  async function* streamText(
    request: Omit<
      RunStructuredRequest<unknown, never>,
      "inputSchema" | "outputSchema" | "images" | "webSearch"
    >,
  ): AsyncIterable<string> {
    const model = modelForTier(request.tier, options.models);
    if (!model.capabilities.includes("streaming")) {
      throw new UnsupportedCapabilityError("streaming");
    }
    const requestedOutputTokens =
      request.maxOutputTokens ??
      options.maxOutputTokens ??
      model.maxOutputTokens;
    if (!Number.isInteger(requestedOutputTokens) || requestedOutputTokens < 1) {
      throw new Error("maxOutputTokens must be a positive integer");
    }
    const maxOutputTokens = Math.min(
      requestedOutputTokens,
      model.maxOutputTokens,
    );
    const dispatchedModel: ModelConfiguration = {
      ...model,
      maxOutputTokens,
      pricingSettings: {
        ...model.pricingSettings,
        maxOutputTokens,
      },
    };
    const inputTokens = inputTokenAllowance({
      system: request.system,
      input: request.input,
    });
    if (inputTokens > model.maxInputTokens) {
      throw new AiError(
        "The model input exceeds the configured token limit",
        "input-limit-exceeded",
      );
    }
    const attemptId = randomUUID();
    const usageAttempt = {
      attemptId,
      context: request.usageContext,
      provider: dispatchedModel.provider,
      model: dispatchedModel.model,
      settings: dispatchedModel.pricingSettings,
      maxInputTokens: inputTokens,
      maxOutputTokens,
      searchRequested: false,
    };
    if (request.signal?.aborted) throw request.signal.reason;
    const admissionSignal = await options.accounting.admit(usageAttempt);
    const timeout = combineSignals(
      request.signal,
      request.timeoutMs ?? defaultTimeout,
    );
    if (timeout.signal.aborted || admissionSignal?.aborted) {
      await options.accounting.cancel(attemptId);
      timeout.clear();
      throw (
        timeout.signal.reason ??
        admissionSignal?.reason ??
        new Error("Model request was cancelled before dispatch")
      );
    }
    const providerSignals = combineAbortSignals([
      timeout.signal,
      admissionSignal,
    ]);
    let recorded = false;

    try {
      for await (const chunk of options.provider.streamText({
        model: dispatchedModel,
        system: request.system,
        input: request.input,
        maxOutputTokens,
        signal: providerSignals.signal,
      })) {
        yield chunk;
      }
    } catch (error) {
      recorded = true;
      await options.accounting.record({
        ...usageAttempt,
        outcome: "unknown",
        units: unknownUsage(),
        errorCode: error instanceof AiError ? error.code : "provider-unknown",
      });
      throw error;
    } finally {
      providerSignals.clear();
      timeout.clear();
      if (!recorded) {
        recorded = true;
        await options.accounting.record({
          ...usageAttempt,
          outcome: "unknown",
          units: unknownUsage(),
        });
      }
    }
  }

  return {
    runStructured,
    streamText,
    extractMultimodal: (request) =>
      runStructured({
        ...request,
        inputSchema: zod.unknown(),
        outputSchema: transcriptionSchema,
        system:
          "Transcribe the supplied document images. Return extracted text, identify OCR versus handwriting, and give a confidence from 0 to 1.",
      }),
  };
}

export interface MuseProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

interface ApiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function normalizeUsage(usage: ApiUsage | undefined): UsageUnits {
  const input = usage?.input_tokens ?? usage?.prompt_tokens ?? null;
  const output = usage?.output_tokens ?? usage?.completion_tokens ?? null;
  const total =
    usage?.total_tokens ??
    (input !== null && output !== null ? input + output : null);
  return {
    input,
    output,
    total,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? null,
    cacheWrite: null,
    search: null,
  };
}

function responseText(body: Record<string, unknown>): string {
  const units = normalizeUsage(body.usage as ApiUsage | undefined);
  if (body.status === "refused") throw new ProviderRefusalError(units);
  if (body.status === "incomplete") throw new ProviderTruncationError(units);
  if (typeof body.output_text === "string") return body.output_text;
  const choices = body.choices;
  if (Array.isArray(choices)) {
    const choice = choices[0] as
      | {
          finish_reason?: string;
          message?: { content?: string; refusal?: string };
        }
      | undefined;
    if (choice?.message?.refusal) throw new ProviderRefusalError(units);
    if (choice?.finish_reason === "length") {
      throw new ProviderTruncationError(units);
    }
    if (typeof choice?.message?.content === "string") {
      return choice.message.content;
    }
  }
  const output = body.output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          ((block as { type?: unknown }).type === "refusal" ||
            typeof (block as { refusal?: unknown }).refusal === "string")
        ) {
          throw new ProviderRefusalError(units);
        }
        if (
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          texts.push((block as { text: string }).text);
        }
      }
    }
    if (texts.length) return texts.join("\n");
  }
  throw new ProviderRequestError(
    "The provider returned an unsupported response",
    undefined,
    undefined,
  );
}

function normalizeCitations(body: Record<string, unknown>): Citation[] {
  const citations: Citation[] = [];
  const output = body.output;
  if (!Array.isArray(output)) return citations;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const annotations = (block as { annotations?: unknown }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        if (!annotation || typeof annotation !== "object") continue;
        const source = annotation as {
          type?: unknown;
          url?: unknown;
          title?: unknown;
          text?: unknown;
        };
        if (
          source.type === "url_citation" &&
          typeof source.url === "string" &&
          typeof source.title === "string"
        ) {
          citations.push({
            url: source.url,
            title: source.title,
            ...(typeof source.text === "string" ? { span: source.text } : {}),
          });
        }
      }
    }
  }
  return citations;
}

export class MuseProvider implements ModelProvider {
  readonly providerName = "muse" as const;
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: MuseProviderOptions) {
    if (!options.apiKey.trim()) throw new Error("Muse API key is required");
    this.baseUrl = new URL(options.baseUrl ?? "https://api.meta.ai/v1");
    if (
      this.baseUrl.protocol !== "https:" &&
      !(
        this.baseUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(this.baseUrl.hostname)
      )
    ) {
      throw new Error("Muse base URL must use HTTPS");
    }

    if (this.baseUrl.username || this.baseUrl.password) {
      throw new Error("Muse base URL must not include credentials");
    }
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/+$/, "")}/`;
    this.baseUrl.search = "";
    this.baseUrl.hash = "";
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<ProviderResult> {
    if (!request.model.capabilities.includes("structured-json")) {
      throw new UnsupportedCapabilityError("structured-json");
    }
    if (
      request.images?.length &&
      !request.model.capabilities.includes("vision")
    ) {
      throw new UnsupportedCapabilityError("vision");
    }
    validateImages(request.images);
    if (
      request.webSearch &&
      !request.model.capabilities.includes("web-search")
    ) {
      throw new UnsupportedCapabilityError("web-search");
    }
    if (request.webSearch && request.images?.length) {
      throw new AiError(
        "Web search cannot be combined with image inputs",
        "unsupported-request-combination",
      );
    }
    let webSearchQuery: string | undefined;
    if (request.webSearch) {
      validateWebSearchQuery(request.input);
      if (typeof request.input !== "string") {
        throw new AiError(
          "Invalid web-search query",
          "invalid-web-search-query",
        );
      }
      webSearchQuery = request.input.trim();
    }

    const isGrounded = request.webSearch;
    const endpoint = isGrounded ? "responses" : "chat/completions";
    const schemaName = "model_output";
    const jsonSchema = {
      name: schemaName,
      strict: true,
      schema: request.schema,
    };
    const userContent: unknown = request.images?.length
      ? [
          { type: "text", text: JSON.stringify(request.input) },
          ...request.images.map((image) => ({
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
            },
          })),
        ]
      : JSON.stringify(request.input);

    const body = isGrounded
      ? {
          model: request.model.model,
          instructions: request.system,
          input: [
            {
              role: "user",
              content: webSearchQuery,
            },
          ],
          max_output_tokens: request.maxOutputTokens,
          tools: [{ type: "web_search" }],
          text: { format: { type: "json_schema", ...jsonSchema } },
        }
      : {
          model: request.model.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: userContent },
          ],
          max_tokens: request.maxOutputTokens,
          response_format: {
            type: "json_schema",
            json_schema: jsonSchema,
          },
        };

    const response = await this.request(endpoint, body, request.signal);
    const text = responseText(response);
    return {
      text,
      units: normalizeUsage(response.usage as ApiUsage | undefined),
      citations: normalizeCitations(response),
    };
  }

  async *streamText(request: {
    model: ModelConfiguration;
    system: string;
    input: unknown;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<string> {
    if (!request.model.capabilities.includes("streaming")) {
      throw new UnsupportedCapabilityError("streaming");
    }
    const response = await this.fetchImplementation(
      new URL("chat/completions", this.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        signal: request.signal,
        body: JSON.stringify({
          model: request.model.model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          max_tokens: request.maxOutputTokens,
          stream: true,
        }),
      },
    );
    if (!response.ok) throw this.requestError(response);
    if (!response.body) {
      throw new ProviderRequestError(
        "The provider returned no stream",
        response.status,
        undefined,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new ProviderTruncationError();
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame
            .split(/\r?\n/)
            .find((entry) => entry.startsWith("data:"));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            completed = true;
            return;
          }
          const event = JSON.parse(data) as {
            error?: unknown;
            choices?: {
              delta?: { content?: string; refusal?: string };
              finish_reason?: string;
            }[];
          };
          if (event.error) {
            throw new ProviderRequestError(
              "The model provider stream failed",
              undefined,
              undefined,
            );
          }
          const choice = event.choices?.[0];
          if (
            typeof choice?.delta?.refusal === "string" &&
            choice.delta.refusal.length > 0
          ) {
            throw new ProviderRefusalError();
          }
          if (choice?.finish_reason === "length") {
            throw new ProviderTruncationError();
          }
          if (typeof choice?.delta?.content === "string") {
            yield choice.delta.content;
          }
        }
      }
    } finally {
      try {
        if (!completed) await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderRequestError(
        "Could not reach the model provider",
        undefined,
        undefined,
      );
    }

    if (!response.ok) throw this.requestError(response);
    const result: unknown = await response.json();
    if (!result || typeof result !== "object") {
      throw new ProviderRequestError(
        "The provider returned an invalid response",
        response.status,
        undefined,
      );
    }
    return result as Record<string, unknown>;
  }

  private requestError(response: Response): ProviderRequestError {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? Number.NaN : Number(header);
    const retryDate = header === null ? Number.NaN : Date.parse(header);
    const retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Number.isFinite(retryDate)
        ? Math.max(0, retryDate - Date.now())
        : undefined;
    return new ProviderRequestError(
      `The model provider request failed (${response.status})`,
      response.status,
      retryAfterMs,
    );
  }
}

export interface MockProviderOptions {
  responses?: readonly string[];
  units?: UsageUnits;
  failure?: Error;
}

export class MockProvider implements ModelProvider {
  readonly providerName = "mock" as const;
  private index = 0;

  constructor(private readonly options: MockProviderOptions = {}) {}

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<ProviderResult> {
    if (request.signal.aborted) throw request.signal.reason;
    if (this.options.failure) throw this.options.failure;
    const responses = this.options.responses ?? [
      '{"text":"Synthetic transcription","method":"ocr","confidence":0.95}',
    ];
    const text = responses[Math.min(this.index, responses.length - 1)];
    this.index += 1;
    return {
      text,
      units: this.options.units ?? {
        input: 0,
        output: 0,
        total: 0,
        reasoning: null,
        cacheRead: null,
        cacheWrite: null,
        search: null,
      },
      citations: [],
    };
  }

  async *streamText(request: {
    model: ModelConfiguration;
    system: string;
    input: unknown;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): AsyncIterable<string> {
    if (request.signal.aborted) throw request.signal.reason;
    const text = this.options.responses?.[0] ?? "Synthetic response";
    for (const token of text.split(/(?<=\s)/)) yield token;
  }
}

export function createMockProvider(
  options?: MockProviderOptions,
): MockProvider {
  return new MockProvider(options);
}

export {
  createAdmittedUsageAccounting,
  estimateUsageCost,
  pricingSettingsKey,
} from "./accounting.js";
