import { S3Client } from "@aws-sdk/client-s3";
import {
  getDocumentStoreConfig,
  getUploadEnvironment,
  type DocumentStoreConfig,
} from "@evianta/env/server";
import type { DocumentStore } from "@evianta/core";
import { FileSystemDocumentStore } from "./document-filesystem.js";
import { S3DocumentStore } from "./document-s3.js";

export function createDocumentStore(
  config: DocumentStoreConfig = getDocumentStoreConfig(),
): DocumentStore {
  const maxUploadBytes = getUploadEnvironment().uploadMaxBytes;
  if (config.driver === "filesystem") {
    return new FileSystemDocumentStore({
      directory: config.localStorageDir,
      maxUploadBytes,
    });
  }
  return new S3DocumentStore({
    client: new S3Client({ region: config.region }),
    bucket: config.bucket,
    maxUploadBytes,
    maxSignedUrlTtlSeconds: config.signedUrlTtlSeconds,
  });
}
