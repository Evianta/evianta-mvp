import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  BoundedStream,
  SignedDocumentStore,
  StoredObject,
} from "@evianta/core";
import { DocumentStoreError } from "./document-errors.js";
import {
  collectUpload,
  destroyBody,
  readObjectBuffer,
  validateObjectKey,
} from "./document-utils.js";

export interface S3DocumentStoreOptions {
  client: S3Client;
  bucket: string;
  maxUploadBytes?: number;
  maxSignedUrlTtlSeconds: number;
}

export class S3DocumentStore implements SignedDocumentStore {
  private readonly maxUploadBytes: number;

  constructor(private readonly options: S3DocumentStoreOptions) {
    if (!options.bucket.trim()) {
      throw new DocumentStoreError("S3 bucket is required", "invalid-config");
    }
    if (
      !Number.isSafeInteger(options.maxSignedUrlTtlSeconds) ||
      options.maxSignedUrlTtlSeconds < 1 ||
      options.maxSignedUrlTtlSeconds > 3600
    ) {
      throw new DocumentStoreError(
        "Maximum signed URL expiry must be between 1 and 3600 seconds",
        "invalid-config",
      );
    }
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
    try {
      await this.options.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: uploaded.key,
          Body: uploaded.bytes,
          ContentLength: uploaded.object.contentLength,
          ContentType: uploaded.object.contentType,
          Metadata: { "content-sha256": uploaded.object.contentHash },
          ServerSideEncryption: "AES256",
        }),
      );
      return uploaded.key;
    } catch (error) {
      throw new DocumentStoreError(
        "S3 document upload failed",
        "s3-write-failed",
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
    let response;
    try {
      response = await this.options.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw new DocumentStoreError(
        "S3 document read failed",
        "s3-read-failed",
        {
          cause: error,
        },
      );
    }

    if (!response.Body) {
      throw new DocumentStoreError(
        "S3 returned an object without a body",
        "corrupt-object",
      );
    }
    const contentLength = response.ContentLength;
    const contentHash = response.Metadata?.["content-sha256"];
    if (
      typeof contentLength !== "number" ||
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      !response.ContentType ||
      typeof contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(contentHash)
    ) {
      destroyBody(response.Body);
      throw new DocumentStoreError(
        "S3 object is missing required metadata",
        "corrupt-object",
      );
    }
    if (!isAsyncByteIterable(response.Body)) {
      destroyBody(response.Body);
      throw new DocumentStoreError(
        "S3 object body is not a readable byte stream",
        "corrupt-object",
      );
    }

    return {
      body: response.Body,
      contentType: response.ContentType,
      contentLength,
      contentHash,
    };
  }

  async deleteAsync(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    try {
      await this.options.client.send(
        new DeleteObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
        }),
      );
    } catch (error) {
      throw new DocumentStoreError(
        "S3 document delete failed",
        "s3-delete-failed",
        {
          cause: error,
        },
      );
    }
  }

  async getSignedUrlAsync(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    validateObjectKey(objectKey);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw new DocumentStoreError(
        "Signed URL expiry must be a positive integer",
        "invalid-expiry",
      );
    }
    const expiresIn = Math.min(
      expiresInSeconds,
      this.options.maxSignedUrlTtlSeconds,
    );
    try {
      return await getSignedUrl(
        this.options.client,
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
        }),
        { expiresIn },
      );
    } catch (error) {
      throw new DocumentStoreError(
        "S3 signed URL generation failed",
        "s3-signing-failed",
        { cause: error },
      );
    }
  }
}

function isAsyncByteIterable(
  value: unknown,
): value is AsyncIterable<Uint8Array> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (
    ("name" in error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")) ||
    ("Code" in error &&
      (error.Code === "NoSuchKey" || error.Code === "NotFound"))
  ) {
    return true;
  }
  return false;
}
