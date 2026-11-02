import { ApiError } from "../api/errors";

export function isRejected(reason: unknown): boolean {
  return (
    reason instanceof ApiError &&
    reason.status >= 400 &&
    reason.status < 500 &&
    reason.status !== 408
  );
}

let counter = 0;

/** Non-secret identifiers for messages, files and idempotency keys. */
export function makeId(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/** Thrown when a chat instance outlived the identity that started its work. */
export class StaleInstanceError extends Error {
  constructor() {
    super("The signed-in identity changed.");
    this.name = "StaleInstanceError";
  }
}

export function isStale(reason: unknown): boolean {
  return reason instanceof StaleInstanceError;
}

/** Wraps an API client so a replaced chat instance can no longer send or consume anything. */
export function guardApi<T extends object>(target: T, alive: () => boolean): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (!alive()) throw new StaleInstanceError();
        const result = await (value as (...input: unknown[]) => unknown).apply(
          object,
          args,
        );
        if (!alive()) throw new StaleInstanceError();
        return result;
      };
    },
  });
}
