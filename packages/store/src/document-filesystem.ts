import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BoundedStream, DocumentStore, StoredObject } from "@evianta/core";
import { DocumentStoreError } from "./document-errors.js";
import {
  collectUpload,
  readObjectBuffer,
  validateObjectKey,
} from "./document-utils.js";

const MetadataSchema = z.object({
  contentType: z.string().min(1),
  contentLength: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface FileSystemDocumentStoreOptions {
  directory: string;
  maxUploadBytes?: number;
}

export class FileSystemDocumentStore implements DocumentStore {
  private readonly directory: string;
  private readonly maxUploadBytes: number;

  constructor(options: FileSystemDocumentStoreOptions) {
    this.directory = resolve(options.directory);
    this.maxUploadBytes = options.maxUploadBytes ?? 10 * 1024 * 1024;
  }

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
    const temporaryDirectory = join(this.directory, `.upload-${randomUUID()}`);
    const targetDirectory = join(this.directory, uploaded.key);
    await mkdir(this.directory, { recursive: true });

    try {
      await mkdir(temporaryDirectory, { mode: 0o700 });
      await writeFile(join(temporaryDirectory, "data"), uploaded.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        join(temporaryDirectory, "metadata.json"),
        JSON.stringify({
          contentType: uploaded.object.contentType,
          contentLength: uploaded.object.contentLength,
          contentHash: uploaded.object.contentHash,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporaryDirectory, targetDirectory);
      return uploaded.key;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        rm(temporaryDirectory, { recursive: true, force: true }),
        rm(targetDirectory, { recursive: true, force: true }),
      ]);
      const cleanupErrors = cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Document upload failed and temporary files could not be removed",
        );
      }
      throw new DocumentStoreError(
        "Filesystem document upload failed",
        "write-failed",
        {
          cause: error,
        },
      );
    }
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
    const objectDirectory = join(this.directory, objectKey);
    let metadataBytes: Buffer;
    try {
      metadataBytes = await readFile(join(objectDirectory, "metadata.json"));
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new DocumentStoreError(
        "Filesystem document metadata could not be read",
        "read-failed",
        {
          cause: error,
        },
      );
    }

    let metadata: z.infer<typeof MetadataSchema>;
    try {
      metadata = MetadataSchema.parse(
        JSON.parse(metadataBytes.toString("utf8")),
      );
    } catch (error) {
      throw new DocumentStoreError(
        "Filesystem document metadata is invalid",
        "corrupt-object",
        {
          cause: error,
        },
      );
    }

    try {
      const fileStat = await stat(join(objectDirectory, "data"));
      if (fileStat.size !== metadata.contentLength) {
        throw new DocumentStoreError(
          "Filesystem document size does not match its metadata",
          "corrupt-object",
        );
      }
    } catch (error) {
      if (error instanceof DocumentStoreError) throw error;
      throw new DocumentStoreError(
        "Filesystem document data could not be read",
        "read-failed",
        {
          cause: error,
        },
      );
    }

    return {
      body: createReadStream(join(objectDirectory, "data")),
      contentType: metadata.contentType,
      contentLength: metadata.contentLength,
      contentHash: metadata.contentHash,
    };
  }

  async deleteAsync(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    try {
      await rm(join(this.directory, objectKey), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      throw new DocumentStoreError(
        "Filesystem document delete failed",
        "delete-failed",
        {
          cause: error,
        },
      );
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
