import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UseCaseSchema } from "../../core/src/domain.js";
import {
  AdmissionRejectedError,
  createAi,
  createMockProvider,
  MockProvider,
  MuseProvider,
  ModelTimeoutError,
  modelForTier,
  ProviderRequestError,
  type StructuredGenerationRequest,
  type UsageAccounting,
} from "../src/index.js";

const models = {
  provider: "mock" as const,
  sparkModel: "mock-spark",
  wonderModel: "mock-wonder",
};

function createAccounting(): UsageAccounting {
  return {
    mode: "admitted",
    admit: vi.fn(),
    record: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("@evianta/ai", () => {
  it("allows an analysis to finish after the old 60-second timeout", async () => {
    vi.useFakeTimers();
    try {
      const accounting = createAccounting();
      const provider = createMockProvider({ responses: ['"tax-notice"'] });
      const generate = provider.generateStructured.bind(provider);
      vi.spyOn(provider, "generateStructured").mockImplementation(
        async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 90_000));
          request.signal.throwIfAborted();
          return generate(request);
        },
      );
      const client = createAi({
        provider,
        accounting,
        models,
        timeoutMs: 180_000,
      });
      const result = client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Analyze records",
        input: "tax-notice",
        usageContext: { userId: "user-1", caseId: "case-1" },
      });
      await vi.advanceTimersByTimeAsync(90_000);
      expect((await result).output).toBe("tax-notice");
      expect(accounting.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "success" }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records actionable timeout errors without retrying an unknown charge", async () => {
    vi.useFakeTimers();
    try {
      const accounting = createAccounting();
      const provider = createMockProvider();
      const dispatch = vi
        .spyOn(provider, "generateStructured")
        .mockImplementation(
          (request) =>
            new Promise((_, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        );
      const client = createAi({
        provider,
        accounting,
        models,
        timeoutMs: 180_000,
      });
      const result = client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Analyze records",
        input: "tax-notice",
        usageContext: { userId: "user-1" },
        timeoutMs: 120_000,
      });
      const assertion = expect(result).rejects.toMatchObject({
        code: "model-timeout",
        message: expect.stringContaining("120-second time limit"),
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(accounting.record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "unknown",
          errorCode: "model-timeout",
        }),
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves caller cancellation instead of reporting a model timeout", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const controller = new AbortController();
    const cancelled = new Error("Caller stopped the run");
    vi.spyOn(provider, "generateStructured").mockImplementation(async () => {
      controller.abort(cancelled);
      throw new DOMException("Aborted", "AbortError");
    });
    const client = createAi({ provider, accounting, models });
    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Analyze",
        input: "tax-notice",
        usageContext: { userId: "user-1" },
        signal: controller.signal,
      }),
    ).rejects.toBe(cancelled);
  });

  it("settles a timed-out paused stream once with its timeout code", async () => {
    vi.useFakeTimers();
    try {
      const accounting = createAccounting();
      const provider = createMockProvider();
      vi.spyOn(provider, "streamText").mockImplementation(
        async function* (request) {
          yield "first";
          request.signal.throwIfAborted();
        },
      );
      const client = createAi({
        provider,
        accounting,
        models,
        timeoutMs: 180_000,
      });
      const stream = client.streamText({
        tier: "cheap",
        system: "Analyze",
        input: "prompt",
        usageContext: { userId: "user-1" },
      });
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ value: "first" });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(accounting.record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          outcome: "unknown",
          errorCode: "model-timeout",
        }),
      );
      await expect(iterator.next()).rejects.toBeInstanceOf(ModelTimeoutError);
      expect(accounting.record).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports actionable 404 errors without exposing provider response bodies", async () => {
    const fetchImplementation: typeof fetch = vi.fn(
      async () =>
        new Response("sensitive provider diagnostics", { status: 404 }),
    );
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const model = modelForTier("cheap", {
      provider: "muse",
      sparkModel: "muse-spark-1.3",
    });
    const request = {
      model,
      system: "Respond",
      input: "hello",
      maxOutputTokens: 50,
      signal: new AbortController().signal,
    };
    const expected = {
      code: "provider-request-failed",
      statusCode: 404,
      message:
        "The model provider request failed (404). Check MUSE_BASE_URL and the configured model ID against the provider's available models.",
    };
    await expect(
      provider.generateStructured({
        ...request,
        schema: { type: "string" },
      }),
    ).rejects.toMatchObject(expected);
    const consume = async () => {
      for await (const chunk of provider.streamText(request)) {
        throw new Error(`Unexpected stream chunk: ${chunk}`);
      }
    };
    await expect(consume()).rejects.toMatchObject(expected);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("resolves cheap and mid to Spark and high to Wonder", () => {
    expect(modelForTier("cheap", models).model).toBe("mock-spark");
    expect(modelForTier("mid", models).model).toBe("mock-spark");
    expect(modelForTier("high", models).model).toBe("mock-wonder");
  });

  it("validates structured output and records normalized usage", async () => {
    const accounting = createAccounting();
    const client = createAi({
      provider: createMockProvider({
        responses: ['"tax-notice"'],
      }),
      accounting,
      models,
    });

    const result = await client.runStructured({
      tier: "cheap",
      inputSchema: UseCaseSchema,
      outputSchema: UseCaseSchema,
      system: "Answer the question",
      input: "data-analysis",
      usageContext: { userId: "user-1", caseId: "case-1" },
      maxOutputTokens: 5,
    });

    expect(result.output).toBe("tax-notice");
    expect(result.cost).toMatchObject({
      status: "unknown",
      costUsd: null,
      pricingIdentity: "mock:mock-spark",
    });
    expect(accounting.admit).toHaveBeenCalledTimes(1);
    expect(accounting.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ maxOutputTokens: 5 }),
        maxOutputTokens: 5,
      }),
    );
    expect(accounting.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        units: expect.any(Object),
      }),
    );
  });

  it("does not reserve or dispatch requests cancelled before admission", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({ provider, accounting, models });
    const controller = new AbortController();
    controller.abort(new Error("request cancelled"));
    const request = {
      tier: "cheap" as const,
      system: "Answer the question",
      input: "data-analysis",
      usageContext: { userId: "user-1", caseId: "case-1" },
      signal: controller.signal,
    };

    await expect(
      client.runStructured({
        ...request,
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
      }),
    ).rejects.toThrow("request cancelled");
    const consumeStream = async () => {
      for await (const chunk of client.streamText(request)) void chunk;
    };
    await expect(consumeStream()).rejects.toThrow("request cancelled");

    expect(accounting.admit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("releases a reservation cancelled immediately before dispatch", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({ provider, accounting, models });
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    vi.mocked(accounting.admit).mockResolvedValue(controller.signal);

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Answer the question",
        input: "data-analysis",
        usageContext: { userId: "user-1", caseId: "case-1" },
      }),
    ).rejects.toThrow("lease lost");

    expect(accounting.admit).toHaveBeenCalledOnce();
    expect(accounting.cancel).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the same JSON snapshot measured before admission", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider({ responses: ['"ok"'] });
    const dispatch = vi.spyOn(provider, "generateStructured");
    let serializeCalls = 0;
    const input = {
      query: "safe prompt",
      toJSON() {
        serializeCalls += 1;
        return {
          query: serializeCalls === 1 ? "safe prompt" : "unbounded prompt",
        };
      },
    };
    vi.mocked(accounting.admit).mockImplementation(async () => {
      input.query = "mutated while admitting";
      return undefined;
    });
    const client = createAi({ provider, accounting, models });

    await client.runStructured({
      tier: "cheap",
      inputSchema: z.unknown(),
      outputSchema: z.string(),
      system: "Answer",
      input,
      usageContext: { userId: "user-1" },
    });

    expect(serializeCalls).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ input: { query: "safe prompt" } }),
    );
  });

  it("dispatches the snapshotted stream input after asynchronous admission", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "streamText");
    const input = { query: "safe prompt" };
    vi.mocked(accounting.admit).mockImplementation(async () => {
      input.query = "mutated while admitting";
      return undefined;
    });
    const client = createAi({ provider, accounting, models });

    for await (const chunk of client.streamText({
      tier: "cheap",
      system: "Answer",
      input,
      usageContext: { userId: "user-1" },
    })) {
      void chunk;
    }

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ input: { query: "safe prompt" } }),
    );
  });

  it("settles a cancelled stream even when the consumer stops pulling", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    vi.spyOn(provider, "streamText").mockImplementation(async function* () {
      yield "first";
      yield "second";
    });
    const client = createAi({ provider, accounting, models });
    const controller = new AbortController();
    const stream = client.streamText({
      tier: "cheap",
      system: "Answer",
      input: "prompt",
      usageContext: { userId: "user-1" },
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: "first" });
    controller.abort(new Error("caller cancelled"));
    await vi.waitFor(() => expect(accounting.record).toHaveBeenCalledOnce());
    expect(accounting.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown" }),
    );

    await iterator.return?.();
    expect(accounting.record).toHaveBeenCalledOnce();
  });

  it("allows one correction attempt for invalid structured output", async () => {
    const accounting = createAccounting();
    const client = createAi({
      provider: createMockProvider({
        responses: ["42", '"msme-payment"'],
      }),
      accounting,
      models,
    });

    const result = await client.runStructured({
      tier: "mid",
      inputSchema: UseCaseSchema,
      outputSchema: UseCaseSchema,
      system: "Return an answer",
      input: "data-analysis",
      usageContext: { userId: "user-1" },
    });

    expect(result.output).toBe("msme-payment");
    expect(accounting.admit).toHaveBeenCalledTimes(2);
    expect(accounting.record).toHaveBeenCalledTimes(2);
  });

  it("retries a transient provider response with a fresh admission", async () => {
    class RetryProvider extends MockProvider {
      attempts = 0;

      override async generateStructured(request: StructuredGenerationRequest) {
        this.attempts += 1;
        if (this.attempts === 1) {
          throw new ProviderRequestError("temporary", 503, 0);
        }
        return super.generateStructured(request);
      }
    }

    const accounting = createAccounting();
    const client = createAi({
      provider: new RetryProvider({
        responses: ['"tax-notice"'],
      }),
      accounting,
      models,
    });

    await client.runStructured({
      tier: "cheap",
      inputSchema: UseCaseSchema,
      outputSchema: UseCaseSchema,
      system: "Return a workflow type",
      input: "data-analysis",
      usageContext: { userId: "user-1" },
    });

    expect(accounting.admit).toHaveBeenCalledTimes(2);
    expect(accounting.record).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch when usage admission is rejected", async () => {
    const accounting = createAccounting();
    vi.mocked(accounting.admit).mockRejectedValueOnce(
      new AdmissionRejectedError(),
    );
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({ provider, accounting, models });

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Return JSON",
        input: "data-analysis",
        usageContext: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(AdmissionRejectedError);

    expect(dispatch).not.toHaveBeenCalled();
    expect(accounting.record).not.toHaveBeenCalled();
  });

  it("rejects oversized inputs before admitting or dispatching", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({
      provider,
      accounting,
      models: { ...models, maxInputTokens: 1 },
    });

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Return JSON",
        input: "data-analysis",
        usageContext: { userId: "user-1" },
      }),
    ).rejects.toMatchObject({ code: "input-limit-exceeded" });
    expect(accounting.admit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires admitted accounting and explicit caps for the paid provider", () => {
    expect(() =>
      createAi({
        provider: createMockProvider(),
        accounting: createAccounting(),
        models: { ...models, provider: "muse" },
      }),
    ).toThrow(AdmissionRejectedError);

    expect(() =>
      createAi({
        provider: createMockProvider(),
        accounting: {
          admit: vi.fn(),
          record: vi.fn(),
          cancel: vi.fn(),
        },
        models: {
          ...models,
          provider: "muse",
          maxInputTokens: 32_000,
          maxOutputTokens: 2_048,
        },
      }),
    ).toThrow(AdmissionRejectedError);
  });

  it("binds paid model configuration to the injected provider adapter", () => {
    expect(() =>
      createAi({
        provider: new MuseProvider({ apiKey: "test-key" }),
        accounting: createAccounting(),
        models,
      }),
    ).toThrow(AdmissionRejectedError);
  });

  it("rejects unbounded paid image and web-search requests before admission", async () => {
    for (const capability of ["vision", "web-search"] as const) {
      const accounting = createAccounting();
      const fetchImplementation: typeof fetch = vi.fn();
      const provider = new MuseProvider({
        apiKey: "test-key",
        fetchImplementation,
      });
      const client = createAi({
        provider,
        accounting,
        models: {
          ...models,
          provider: "muse",
          maxInputTokens: 32_000,
          maxOutputTokens: 2_048,
          capabilitiesByTier: {
            cheap: ["structured-json", "vision", "web-search"],
          },
        },
      });

      await expect(
        client.runStructured({
          tier: "cheap",
          inputSchema: z.unknown(),
          outputSchema: z.string(),
          system: "Research",
          input: "A valid search query",
          usageContext: { userId: "user-1" },
          ...(capability === "vision"
            ? {
                images: [
                  {
                    mimeType: "image/png",
                    bytes: new Uint8Array([1]),
                  },
                ],
              }
            : { webSearch: true }),
        }),
      ).rejects.toMatchObject({ code: "unbounded-usage-capability" });
      expect(accounting.admit).not.toHaveBeenCalled();
      expect(fetchImplementation).not.toHaveBeenCalled();
    }
  });

  it("validates web-search input before usage admission", async () => {
    const accounting = createAccounting();
    const client = createAi({
      provider: createMockProvider(),
      accounting,
      models,
    });

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: z.unknown(),
        outputSchema: z.string(),
        system: "Search",
        input: { query: "not an explicit query" },
        usageContext: { userId: "user-1" },
        webSearch: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-web-search-query" });
    expect(accounting.admit).not.toHaveBeenCalled();
  });

  it("does not attach a timeout listener when output schema conversion fails", async () => {
    const accounting = createAccounting();
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({ provider, accounting, models });
    const signal = new AbortController().signal;
    const addEventListener = vi.spyOn(signal, "addEventListener");

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: z.string().transform((value) => value),
        system: "Return JSON",
        input: "data-analysis",
        usageContext: { userId: "user-1" },
        signal,
      }),
    ).rejects.toThrow();

    expect(addEventListener).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accounts for streamed calls as unknown until provider usage is available", async () => {
    const accounting = createAccounting();
    const client = createAi({
      provider: createMockProvider(),
      accounting,
      models,
    });
    const chunks: string[] = [];

    for await (const chunk of client.streamText({
      tier: "mid",
      system: "Respond briefly",
      input: { prompt: "hello" },
      usageContext: { userId: "user-1" },
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Synthetic response");
    expect(accounting.admit).toHaveBeenCalledTimes(1);
    expect(accounting.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown" }),
    );
  });

  it("rejects a streamed response that ends before the completion marker", async () => {
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    });
    const model = modelForTier("cheap", { ...models, provider: "muse" });
    const chunks: string[] = [];
    const consume = async () => {
      for await (const _chunk of provider.streamText({
        model,
        system: "Respond",
        input: "hello",
        maxOutputTokens: 50,
        signal: new AbortController().signal,
      })) {
        chunks.push(_chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "provider-truncated",
    });
    expect(chunks).toEqual(["partial"]);
  });

  it("raises provider refusals received in a stream", async () => {
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response(
          'data: {"choices":[{"delta":{"refusal":"I cannot help"}}]}\n\n',
        ),
    });
    const model = modelForTier("cheap", { ...models, provider: "muse" });
    const chunks: string[] = [];
    const consume = async () => {
      for await (const chunk of provider.streamText({
        model,
        system: "Respond",
        input: "hello",
        maxOutputTokens: 50,
        signal: new AbortController().signal,
      })) {
        chunks.push(chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "provider-refusal",
    });
    expect(chunks).toEqual([]);
  });

  it("raises provider errors after partial streamed content", async () => {
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"partial"}}]}',
            "",
            'data: {"error":{"message":"upstream failure","type":"server_error"}}',
            "",
            "data: [DONE]",
            "",
            "",
          ].join("\n"),
        ),
    });
    const model = modelForTier("cheap", { ...models, provider: "muse" });
    const chunks: string[] = [];
    const consume = async () => {
      for await (const chunk of provider.streamText({
        model,
        system: "Respond",
        input: "hello",
        maxOutputTokens: 50,
        signal: new AbortController().signal,
      })) {
        chunks.push(chunk);
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "provider-request-failed",
      message: "The model provider stream failed",
    });
    expect(chunks).toEqual(["partial"]);
  });

  it("cancels the provider response when a stream consumer stops early", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
          ),
        );
      },
      cancel,
    });
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation: async () => new Response(body),
    });
    const model = modelForTier("cheap", { ...models, provider: "muse" });

    for await (const chunk of provider.streamText({
      model,
      system: "Respond",
      input: "hello",
      maxOutputTokens: 50,
      signal: new AbortController().signal,
    })) {
      expect(chunk).toBe("first");
      break;
    }

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("uses the configured Muse endpoint and normalizes response usage", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: '"tax-notice"' },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
            completion_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const model = modelForTier("cheap", {
      ...models,
      provider: "muse",
    });
    const result = await provider.generateStructured({
      model,
      system: "Return a workflow type",
      input: { text: "sample" },
      schema: { type: "string" },
      maxOutputTokens: 50,
      signal: new AbortController().signal,
    });

    expect(requests[0]?.url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(requests[0]?.body.model).toBe("mock-spark");
    expect(result.text).toBe('"tax-notice"');
    expect(result.units).toMatchObject({
      input: 8,
      output: 3,
      total: 11,
      reasoning: 1,
    });
  });

  it("keeps web-search input to an explicit query and normalizes citations", async () => {
    const requests: Record<string, unknown>[] = [];
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          status: "completed",
          output_text: '"tax-notice"',
          output: [
            {
              content: [
                {
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.test/tax",
                      title: "Tax source",
                      text: "Relevant passage",
                    },
                  ],
                },
              ],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const model = modelForTier("cheap", {
      provider: "muse",
      sparkModel: "spark",
      wonderModel: "wonder",
      capabilitiesByTier: {
        cheap: ["structured-json", "web-search"],
      },
    });
    const result = await provider.generateStructured({
      model,
      system: "Research the query",
      input: "   GST input tax credit rule   ",
      schema: { type: "string" },
      maxOutputTokens: 50,
      signal: new AbortController().signal,
      webSearch: true,
    });

    expect(requests[0]?.input).toEqual([
      { role: "user", content: "GST input tax credit rule" },
    ]);
    expect(result.citations).toEqual([
      {
        url: "https://example.test/tax",
        title: "Tax source",
        span: "Relevant passage",
      },
    ]);
  });

  it("rejects unbounded search input before making a request", async () => {
    const fetchImplementation: typeof fetch = vi.fn();
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const model = modelForTier("cheap", {
      provider: "muse",
      sparkModel: "spark",
      wonderModel: "wonder",
      capabilitiesByTier: {
        cheap: ["structured-json", "web-search"],
      },
    });

    await expect(
      provider.generateStructured({
        model,
        system: "Research",
        input: { privateDocument: "do not send" },
        schema: { type: "string" },
        maxOutputTokens: 50,
        signal: new AbortController().signal,
        webSearch: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-web-search-query" });
    await expect(
      provider.generateStructured({
        model,
        system: "Research",
        input: "x".repeat(501),
        schema: { type: "string" },
        maxOutputTokens: 50,
        signal: new AbortController().signal,
        webSearch: true,
      }),
    ).rejects.toMatchObject({ code: "invalid-web-search-query" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects image inputs combined with web search before dispatch", async () => {
    const provider = createMockProvider();
    const dispatch = vi.spyOn(provider, "generateStructured");
    const client = createAi({
      provider,
      accounting: createAccounting(),
      models,
    });

    await expect(
      client.runStructured({
        tier: "cheap",
        inputSchema: UseCaseSchema,
        outputSchema: UseCaseSchema,
        system: "Research this image",
        input: "data-analysis",
        usageContext: { userId: "user-1" },
        images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
        webSearch: true,
      }),
    ).rejects.toMatchObject({ code: "unsupported-request-combination" });

    expect(dispatch).not.toHaveBeenCalled();

    const fetchImplementation: typeof fetch = vi.fn();
    const museProvider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const museModel = modelForTier("cheap", {
      provider: "muse",
      sparkModel: "spark",
      wonderModel: "wonder",
      capabilitiesByTier: {
        cheap: ["structured-json", "vision", "web-search"],
      },
    });

    await expect(
      museProvider.generateStructured({
        model: museModel,
        system: "Research this image",
        input: "What is in this picture?",
        schema: { type: "string" },
        maxOutputTokens: 50,
        signal: new AbortController().signal,
        images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
        webSearch: true,
      }),
    ).rejects.toMatchObject({ code: "unsupported-request-combination" });

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("records known usage for provider refusals and truncations", async () => {
    for (const [status, errorCode] of [
      ["refused", "provider-refusal"],
      ["incomplete", "provider-truncated"],
    ] as const) {
      const accounting = createAccounting();
      const provider = new MuseProvider({
        apiKey: "test-key",
        fetchImplementation: async () =>
          new Response(
            JSON.stringify({
              status,
              usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            }),
            { status: 200 },
          ),
      });
      const client = createAi({
        provider,
        accounting,
        models: {
          ...models,
          provider: "muse",
          maxInputTokens: 32_000,
          maxOutputTokens: 2_048,
        },
      });

      await expect(
        client.runStructured({
          tier: "cheap",
          inputSchema: UseCaseSchema,
          outputSchema: UseCaseSchema,
          system: "Return a workflow type",
          input: "data-analysis",
          usageContext: { userId: "user-1" },
        }),
      ).rejects.toMatchObject({ code: errorCode });

      expect(accounting.record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          units: expect.objectContaining({ input: 8, output: 2, total: 10 }),
        }),
      );
    }
  });

  it.each(["chat", "responses"] as const)(
    "reports %s output exhaustion and records reasoning usage without a paid retry",
    async (protocol) => {
      const accounting = createAccounting();
      const usage = {
        prompt_tokens: 815,
        completion_tokens: 2048,
        total_tokens: 2863,
        completion_tokens_details: { reasoning_tokens: 2046 },
      };
      const fetchImplementation: typeof fetch = vi.fn(async () =>
        Response.json({
          ...(protocol === "chat"
            ? {
                choices: [
                  {
                    finish_reason: "length",
                    message: { content: "" },
                  },
                ],
              }
            : {
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
              }),
          usage,
        }),
      );
      const client = createAi({
        provider: new MuseProvider({
          apiKey: "test-key",
          fetchImplementation,
        }),
        accounting,
        models: {
          provider: "muse",
          sparkModel: "muse-spark-1.3",
          maxInputTokens: 32_000,
          maxOutputTokens: 2048,
        },
      });
      await expect(
        client.runStructured({
          tier: "cheap",
          inputSchema: z.string(),
          outputSchema: z.string(),
          system: "Return a workflow type",
          input: "data-analysis",
          usageContext: { userId: "user-1" },
        }),
      ).rejects.toMatchObject({
        code: "provider-truncated",
        message:
          "The model exhausted its 2048-token output limit (including reasoning). Increase MODEL_MAX_OUTPUT_TOKENS or request a shorter response, then retry.",
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(accounting.admit).toHaveBeenCalledTimes(1);
      expect(accounting.record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failed",
          errorCode: "provider-truncated",
          units: expect.objectContaining({
            input: 815,
            output: 2048,
            reasoning: 2046,
            total: 2863,
          }),
        }),
      );
    },
  );

  it("admits and dispatches the larger reasoning-inclusive output allowance", async () => {
    const accounting = createAccounting();
    const fetchImplementation: typeof fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '"data-analysis"' },
          },
        ],
        usage: {
          prompt_tokens: 815,
          completion_tokens: 2500,
          total_tokens: 3315,
          completion_tokens_details: { reasoning_tokens: 2046 },
        },
      }),
    );
    const client = createAi({
      provider: new MuseProvider({ apiKey: "test-key", fetchImplementation }),
      accounting,
      models: {
        provider: "muse",
        sparkModel: "muse-spark-1.3",
        maxInputTokens: 32_000,
        maxOutputTokens: 16384,
      },
    });
    const result = await client.runStructured({
      tier: "cheap",
      inputSchema: UseCaseSchema,
      outputSchema: UseCaseSchema,
      system: "Return a workflow type",
      input: "data-analysis",
      usageContext: { userId: "user-1" },
    });
    expect(result.output).toBe("data-analysis");
    expect(accounting.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 16384,
        settings: { maxOutputTokens: 16384 },
      }),
    );
    const [, init] = vi.mocked(fetchImplementation).mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "muse-spark-1.3",
      max_tokens: 16384,
    });
    expect(accounting.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        units: expect.objectContaining({ output: 2500, reasoning: 2046 }),
      }),
    );
  });

  it("distinguishes streamed token exhaustion from a prematurely ended stream", async () => {
    const provider = new MuseProvider({
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response('data: {"choices":[{"finish_reason":"length"}]}\n\n'),
    });
    const consume = async () => {
      for await (const chunk of provider.streamText({
        model: modelForTier("cheap", {
          provider: "muse",
          sparkModel: "muse-spark-1.3",
        }),
        system: "Respond",
        input: "hello",
        maxOutputTokens: 100,
        signal: new AbortController().signal,
      })) {
        throw new Error(`Unexpected stream chunk: ${chunk}`);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "provider-truncated",
      message: expect.stringContaining("100-token output limit"),
    });
  });
});
