import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UseCaseSchema } from "../../core/src/domain.js";
import {
  AdmissionRejectedError,
  createAi,
  createMockProvider,
  MockProvider,
  MuseProvider,
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
    admit: vi.fn(),
    record: vi.fn(),
  };
}

describe("@evianta/ai", () => {
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
    });

    expect(result.output).toBe("tax-notice");
    expect(result.cost).toMatchObject({
      status: "unknown",
      costUsd: null,
      pricingIdentity: "mock:mock-spark",
    });
    expect(accounting.admit).toHaveBeenCalledTimes(1);
    expect(accounting.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        units: expect.any(Object),
      }),
    );
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
        models: { ...models, provider: "muse" },
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
});
