import { describe, expect, it } from "vitest";

import {
  getDocumentStoreConfig,
  getMongoDbUri,
  getRequiredEnv,
} from "../src/server.js";

describe("getRequiredEnv", () => {
  it("returns a configured value", () => {
    expect(
      getRequiredEnv("DATABASE_URL", { DATABASE_URL: "mongodb://local" }),
    ).toBe("mongodb://local");
  });

  describe("getMongoDbUri", () => {
    it("requires a MongoDB URI with a database name", () => {
      expect(
        getMongoDbUri({
          MONGODB_URI: "mongodb://localhost:27017/evianta",
        }),
      ).toBe("mongodb://localhost:27017/evianta");
      expect(() =>
        getMongoDbUri({ MONGODB_URI: "mongodb://localhost:27017/" }),
      ).toThrow("MONGODB_URI must include a database name");
    });

    it("rejects malformed or non-MongoDB URIs", () => {
      expect(() => getMongoDbUri({ MONGODB_URI: "not-a-uri" })).toThrow(
        "MONGODB_URI must be a valid MongoDB URI",
      );
      expect(() =>
        getMongoDbUri({ MONGODB_URI: "https://example.test/evianta" }),
      ).toThrow("MONGODB_URI must use mongodb:// or mongodb+srv://");
    });
  });

  describe("getDocumentStoreConfig", () => {
    it("uses a configured local filesystem store during development", () => {
      expect(
        getDocumentStoreConfig({
          NODE_ENV: "development",
          DOCUMENT_STORE: "filesystem",
          LOCAL_STORAGE_DIR: ".data/documents",
        }),
      ).toEqual({
        driver: "filesystem",
        localStorageDir: ".data/documents",
      });
    });

    it("rejects local stores in production", () => {
      expect(() =>
        getDocumentStoreConfig({
          NODE_ENV: "production",
          DOCUMENT_STORE: "filesystem",
          LOCAL_STORAGE_DIR: ".data/documents",
        }),
      ).toThrow('DOCUMENT_STORE must be "s3" in production');
    });

    it("requires production S3 configuration without returning secrets", () => {
      const config = getDocumentStoreConfig({
        NODE_ENV: "production",
        DOCUMENT_STORE: "s3",
        AWS_REGION: "ap-south-1",
        S3_BUCKET: "private-documents",
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        S3_DOWNLOAD_TTL_SECONDS: "120",
      });

      expect(config).toEqual({
        driver: "s3",
        region: "ap-south-1",
        bucket: "private-documents",
        signedUrlTtlSeconds: 120,
      });
      expect(config).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    });

    it("rejects invalid S3 signing TTLs and incomplete configuration", () => {
      expect(() =>
        getDocumentStoreConfig({
          DOCUMENT_STORE: "s3",
          AWS_REGION: "ap-south-1",
          S3_BUCKET: "private-documents",
          AWS_ACCESS_KEY_ID: "test-access-key",
          AWS_SECRET_ACCESS_KEY: "test-secret-key",
          S3_DOWNLOAD_TTL_SECONDS: "3601",
        }),
      ).toThrow("S3_DOWNLOAD_TTL_SECONDS must not exceed 3600");
      expect(() =>
        getDocumentStoreConfig({
          DOCUMENT_STORE: "s3",
          AWS_REGION: "ap-south-1",
          S3_BUCKET: "private-documents",
        }),
      ).toThrow('Required environment variable "AWS_ACCESS_KEY_ID" is not set');
    });
  });

  it("rejects a missing or blank value", () => {
    expect(() => getRequiredEnv("DATABASE_URL", {})).toThrow(
      'Required environment variable "DATABASE_URL" is not set',
    );
    expect(() =>
      getRequiredEnv("DATABASE_URL", { DATABASE_URL: "  " }),
    ).toThrow('Required environment variable "DATABASE_URL" is not set');
  });
});
