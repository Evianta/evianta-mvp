export type IngestionErrorCode =
  | "document-not-found"
  | "usage-context-mismatch"
  | "document-bytes-missing"
  | "content-hash-mismatch"
  | "unsupported-format"
  | "content-type-mismatch"
  | "size-limit-exceeded"
  | "page-limit-exceeded"
  | "decompression-limit-exceeded"
  | "image-limit-exceeded"
  | "row-limit-exceeded"
  | "parser-timeout"
  | "parse-failed";

export class IngestionError extends Error {
  constructor(
    message: string,
    readonly code: IngestionErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(
            new IngestionError(
              "Document parsing exceeded its time limit",
              "parser-timeout",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
