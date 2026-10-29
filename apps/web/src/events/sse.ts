import { RunEventSchema, type RunEvent } from "@evianta/core";
import { ApiError } from "../api/errors";

export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  let completed = false;

  const dispatch = (): SseMessage | null => {
    if (data.length === 0) {
      event = "message";
      return null;
    }
    const message = { id, event, data: data.join("\n") };
    event = "message";
    data = [];
    return message;
  };

  const processLine = (line: string): SseMessage | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    if (field === "event") event = value || "message";
    if (field === "id" && !value.includes("\0")) id = value;
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        const message = processLine(line);
        if (message) yield message;
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer) {
          const message = processLine(
            buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer,
          );
          if (message) yield message;
        }
        const message = dispatch();
        if (message) yield message;
        completed = true;
        return;
      }
    }
  } finally {
    if (!completed) await reader.cancel();
    reader.releaseLock();
  }
}

export interface RunEventStreamOptions {
  url: string;
  token: string;
  afterSequence?: number;
  signal: AbortSignal;
  onUnauthorized: () => void;
  onEvent: (event: RunEvent) => void;
  onResync?: (lastSequence: number, nextSequence: number) => void;
  replayOnly?: boolean;
  fetcher?: typeof fetch;
  maxReconnects?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function streamRunEvents(
  options: RunEventStreamOptions,
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxReconnects = options.maxReconnects ?? 5;
  let lastSequence = options.afterSequence ?? 0;
  let lastEventId: string | null = null;

  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    if (options.signal.aborted) return;
    try {
      const headers = new Headers({
        Accept: "text/event-stream",
        Authorization: `Bearer ${options.token}`,
      });
      if (lastEventId) headers.set("Last-Event-ID", lastEventId);
      const separator = options.url.includes("?") ? "&" : "?";
      const url = `${options.url}${separator}afterSequence=${lastSequence}`;
      const response = await fetcher(url, {
        headers,
        cache: "no-store",
        signal: options.signal,
      });
      if (response.status === 401) {
        options.onUnauthorized();
        throw new ApiError(401, "Your session expired. Sign in again.");
      }
      if (!response.ok) {
        throw new ApiError(response.status, "The run event stream failed.");
      }
      if (!response.body) {
        throw new ApiError(502, "The server returned an empty event stream.");
      }

      for await (const message of parseSseStream(response.body)) {
        if (!message.data) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(message.data);
        } catch (error) {
          throw new ApiError(502, "The server sent an invalid run event.", {
            cause: error,
          });
        }
        const parsed = RunEventSchema.safeParse(payload);
        if (!parsed.success) {
          throw new ApiError(502, "The server sent an invalid run event.", {
            cause: parsed.error,
          });
        }
        const runEvent = parsed.data;
        if (runEvent.sequence <= lastSequence) continue;
        if (lastSequence > 0 && runEvent.sequence > lastSequence + 1) {
          options.onResync?.(lastSequence, runEvent.sequence);
          throw new ApiError(409, "Run events were skipped; resynchronizing.");
        }
        lastSequence = runEvent.sequence;
        lastEventId = message.id ?? runEvent.id;
        options.onEvent(runEvent);
        if (isTerminal(runEvent)) return;
      }
      if (options.replayOnly) return;
      if (attempt === maxReconnects) {
        throw new ApiError(
          503,
          "The run event stream disconnected before a terminal event arrived.",
        );
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) throw error;
      if (attempt === maxReconnects) {
        throw error instanceof ApiError
          ? error
          : new ApiError(503, "The run event stream disconnected.", {
              cause: error,
            });
      }
    }

    if (attempt < maxReconnects) {
      await sleep((options.retryDelayMs ?? 250) * 2 ** attempt);
    }
  }
}

function isTerminal(event: RunEvent): boolean {
  return [
    "run-completed",
    "run-failed",
    "run-cancelled",
    "limit-reached",
    "input-required",
  ].includes(event.payload.type);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
