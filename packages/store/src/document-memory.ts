import type { BoundedStream, DocumentStore, StoredObject } from "@evianta/core";
import {
  bytesFromBuffer,
  collectUpload,
  readObjectBuffer,
  validateObjectKey,
} from "./document-utils.js";

interface StoredDocument {
  bytes: Buffer;
  contentType: string;
  contentHash: string;
}

export class InMemoryDocumentStore implements DocumentStore {
  private readonly objects = new Map<string, StoredDocument>();

  constructor(private readonly maxUploadBytes = 10 * 1024 * 1024) {}

  async uploadAsync(
    caseId: string,
    mimeType: string,
    boundedStream: BoundedStream,
  ): Promise<string> {
    const uploaded = await collectUpload(
      caseId,
      mimeType,
      boundedStream,
      this.maxUploadBytes,
    );
    this.objects.set(uploaded.key, {
      bytes: uploaded.bytes,
      contentType: uploaded.object.contentType,
      contentHash: uploaded.object.contentHash,
    });
    return uploaded.key;
  }

  async readBufferAsync(
    objectKey: string,
    maxBytes: number,
  ): Promise<Uint8Array | null> {
    const object = await this.readStreamAsync(objectKey);
    if (!object) return null;
    return readObjectBuffer(object, maxBytes);
  }

  async readStreamAsync(objectKey: string): Promise<StoredObject | null> {
    validateObjectKey(objectKey);
    const object = this.objects.get(objectKey);
    if (!object) return null;
    return {
      body: bytesFromBuffer(object.bytes),
      contentType: object.contentType,
      contentLength: object.bytes.byteLength,
      contentHash: object.contentHash,
    };
  }

  async deleteAsync(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    this.objects.delete(objectKey);
  }
}
