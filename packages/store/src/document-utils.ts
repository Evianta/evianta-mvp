import { createHash, randomUUID } from "node:crypto";
import type { BoundedStream, StoredObject } from "@evianta/core";
import { DocumentStoreError } from "./document-errors.js";

const objectKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createObjectKey(): string {
  return randomUUID();
}

export function validateObjectKey(objectKey: string): void {
  if (!objectKeyPattern.test(objectKey)) {
    throw new DocumentStoreError("Invalid document object key", "invalid-key");
  }
}

export async function collectUpload(
  caseId: string,
  mimeType: string,
  stream: BoundedStream,
  maxBytes: number,
): Promise<{ key: string; object: StoredObject; bytes: Buffer }> {
  if (!caseId.trim()) {
    throw new DocumentStoreError("Case ID is required", "invalid-upload");
  }
  if (
    !mimeType.includes("/") ||
    mimeType.length > 255 ||
    /[\r\n]/.test(mimeType)
  ) {
    throw new DocumentStoreError("Invalid MIME type", "invalid-upload");
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    !Number.isSafeInteger(stream.contentLength) ||
    stream.contentLength < 0
  ) {
    throw new DocumentStoreError("Invalid document size", "invalid-upload");
  }
  if (stream.contentLength > maxBytes) {
    throw new DocumentStoreError(
      "Document exceeds the upload limit",
      "too-large",
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(stream.contentHash)) {
    throw new DocumentStoreError(
      "Invalid SHA-256 content hash",
      "invalid-upload",
    );
  }

  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let contentLength = 0;
  try {
    for await (const chunk of stream.body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new DocumentStoreError(
          "Document stream yielded a non-byte chunk",
          "invalid-upload",
        );
      }
      contentLength += chunk.byteLength;
      if (contentLength > maxBytes || contentLength > stream.contentLength) {
        throw new DocumentStoreError(
          "Document stream exceeds its declared size",
          "too-large",
        );
      }
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      hash.update(bytes);
    }
  } catch (error) {
    if (error instanceof DocumentStoreError) throw error;
    throw new DocumentStoreError(
      "Document upload stream failed",
      "upload-failed",
      {
        cause: error,
      },
    );
  }
  if (contentLength !== stream.contentLength) {
    throw new DocumentStoreError(
      "Document stream does not match its declared size",
      "invalid-upload",
    );
  }
  if (hash.digest("hex") !== stream.contentHash.toLowerCase()) {
    throw new DocumentStoreError(
      "Document stream does not match its declared hash",
      "invalid-upload",
    );
  }

  const key = createObjectKey();
  const bytes = Buffer.concat(chunks);
  return {
    key,
    bytes,
    object: {
      body: bytesFromBuffer(bytes),
      contentType: mimeType,
      contentLength,
      contentHash: stream.contentHash.toLowerCase(),
    },
  };
}

export async function readObjectBuffer(
  object: StoredObject,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    destroyBody(object.body);
    throw new DocumentStoreError("Invalid read limit", "invalid-limit");
  }
  if (object.contentLength > maxBytes) {
    destroyBody(object.body);
    throw new DocumentStoreError(
      "Document exceeds the read limit",
      "too-large",
    );
  }

  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let contentLength = 0;
  try {
    for await (const chunk of object.body) {
      contentLength += chunk.byteLength;
      if (contentLength > maxBytes || contentLength > object.contentLength) {
        throw new DocumentStoreError(
          "Document stream exceeds its stored size",
          "corrupt-object",
        );
      }
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      hash.update(bytes);
    }
  } catch (error) {
    if (error instanceof DocumentStoreError) throw error;
    throw new DocumentStoreError("Document read stream failed", "read-failed", {
      cause: error,
    });
  }
  if (
    contentLength !== object.contentLength ||
    hash.digest("hex") !== object.contentHash.toLowerCase()
  ) {
    throw new DocumentStoreError(
      "Stored document metadata does not match its contents",
      "corrupt-object",
    );
  }
  return Buffer.concat(chunks);
}

export function bytesFromBuffer(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Uint8Array.from(buffer);
  })();
}

export function destroyBody(body: unknown): void {
  if (
    typeof body === "object" &&
    body !== null &&
    "destroy" in body &&
    typeof body.destroy === "function"
  ) {
    body.destroy();
  }
}
