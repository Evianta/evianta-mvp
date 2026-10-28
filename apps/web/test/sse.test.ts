import { describe, expect, it, vi } from "vitest";
import { parseSseStream, streamRunEvents } from "../src/events/sse.js";

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function runEvent(
  sequence: number,
  type:
    | "task-started"
    | "run-completed"
    | "run-failed"
    | "run-cancelled"
    | "limit-reached"
    | "input-required",
): string {
  const payload = (() => {
    switch (type) {
      case "task-started":
        return { type, taskId: "task-1", role: "analyst" };
      case "run-completed":
        return { type, deliverableIds: ["deliverable-1"] };
      case "run-failed":
        return {
          type,
          error: { code: "failed", message: "Run failed." },
        };
      case "run-cancelled":
        return { type, reason: "Cancelled by user." };
      case "limit-reached":
        return { type, limit: "monthly budget" };
      case "input-required":
        return { type, questionIds: ["question-1"] };
    }
  })();
  return JSON.stringify({
    id: `event-${sequence}`,
    caseId: "case-1",
    runId: "run-1",
    sequence,
    occurredAt: "2026-01-15T00:00:00.000Z",
    payload,
  });
}

describe("SSE event handling", () => {
  it("parses fragmented UTF-8 frames, multi-line data and heartbeat comments", async () => {
    const stream = byteStream([
      ': heartbeat\r\nid: 42\r\nevent: update\r\ndata: {"label":\r\n',
      'data: "evianta €"}\r\n\r\nid: 43\ndata: last',
    ]);
    const messages = [];
    for await (const message of parseSseStream(stream)) messages.push(message);
    expect(messages).toEqual([
      { id: "42", event: "update", data: '{"label":\n"evianta €"}' },
      { id: "43", event: "message", data: "last" },
    ]);
  });

  it("deduplicates replayed events, requests resync on gaps and stops at terminal events", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          byteStream([`id: event-1\ndata: ${runEvent(1, "task-started")}\n\n`]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          byteStream([
            `id: event-1\ndata: ${runEvent(1, "task-started")}\n\n`,
            `id: event-3\ndata: ${runEvent(3, "run-completed")}\n\n`,
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          byteStream([
            `id: event-2\ndata: ${runEvent(2, "task-started")}\n\n`,
            `id: event-3\ndata: ${runEvent(3, "run-completed")}\n\n`,
          ]),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const controller = new AbortController();

    await streamRunEvents({
      url: "https://api.example.test/runs/run-1/events",
      token: "in-memory-token",
      signal: controller.signal,
      onUnauthorized: vi.fn(),
      onEvent,
      onResync,
      fetcher,
      maxReconnects: 3,
      retryDelayMs: 0,
      sleep,
    });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls.map(([event]) => event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(onResync).toHaveBeenCalledWith(1, 3);
    const reconnectHeaders = new Headers(fetcher.mock.calls[2][1]?.headers);
    expect(reconnectHeaders.get("Authorization")).toBe(
      "Bearer in-memory-token",
    );
    expect(reconnectHeaders.get("Last-Event-ID")).toBe("event-1");
    expect(fetcher.mock.calls[2][0]).toContain("afterSequence=1");
  });

  it("clears the session on 401 and surfaces the auth failure", async () => {
    const onUnauthorized = vi.fn();
    await expect(
      streamRunEvents({
        url: "https://api.example.test/runs/run-1/events",
        token: "expired-token",
        signal: new AbortController().signal,
        onUnauthorized,
        onEvent: vi.fn(),
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 401 })),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([
    "run-failed",
    "run-cancelled",
    "limit-reached",
    "input-required",
  ] as const)(
    "stops reconnecting after the %s terminal state",
    async (type) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            byteStream([`id: terminal\ndata: ${runEvent(1, type)}\n\n`]),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      const onEvent = vi.fn();
      const sleep = vi.fn(async () => undefined);
      await streamRunEvents({
        url: "https://api.example.test/runs/run-1/events",
        token: "in-memory-token",
        signal: new AbortController().signal,
        onUnauthorized: vi.fn(),
        onEvent,
        fetcher,
        sleep,
      });
      expect(onEvent).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
