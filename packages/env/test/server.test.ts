import { describe, expect, it } from "vitest";

import {
  getAiEnvironment,
  getApiEnvironment,
  getDocumentStoreConfig,
  getMongoConfig,
  getRequiredEnv,
  getUploadEnvironment,
  getUsageEnvironment,
} from "../src/server.js";

describe("getRequiredEnv", () => {
  it("returns a configured value", () => {
    expect(
      getRequiredEnv("DATABASE_URL", { DATABASE_URL: "mongodb://local" }),
    ).toBe("mongodb://local");
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

describe("getMongoConfig", () => {
  it("returns the URI and database name from separate variables", () => {
    expect(
      getMongoConfig({
        MONGODB_URI: "mongodb://localhost:27017",
        MONGODB_DB: "evianta",
      }),
    ).toEqual({ uri: "mongodb://localhost:27017", dbName: "evianta" });
    expect(
      getMongoConfig({
        MONGODB_URI: "mongodb+srv://cluster.example.net/?retryWrites=true",
        MONGODB_DB: "evianta",
      }).dbName,
    ).toBe("evianta");
  });

  it("requires both variables", () => {
    expect(() => getMongoConfig({ MONGODB_DB: "evianta" })).toThrow(
      'Required environment variable "MONGODB_URI" is not set',
    );
    expect(() =>
      getMongoConfig({ MONGODB_URI: "mongodb://localhost:27017" }),
    ).toThrow('Required environment variable "MONGODB_DB" is not set');
  });

  it("rejects non-MongoDB URIs", () => {
    expect(() =>
      getMongoConfig({
        MONGODB_URI: "https://example.test",
        MONGODB_DB: "evianta",
      }),
    ).toThrow("MONGODB_URI must use mongodb:// or mongodb+srv://");
  });

  it("rejects invalid database names", () => {
    for (const dbName of [
      "a/b",
      "a b",
      "a.b",
      "a$b",
      "a".repeat(64),
      "é".repeat(32),
    ]) {
      expect(() =>
        getMongoConfig({
          MONGODB_URI: "mongodb://localhost:27017",
          MONGODB_DB: dbName,
        }),
      ).toThrow("MONGODB_DB must be a valid MongoDB database name");
    }
  });
});

describe("getUploadEnvironment", () => {
  it("uses bounded defaults and validates configured limits", () => {
    expect(getUploadEnvironment({})).toEqual({
      uploadMaxBytes: 25 * 1024 * 1024,
      uploadMaxFiles: 10,
      documentMaxPages: 100,
    });
    expect(() =>
      getUploadEnvironment({ UPLOAD_MAX_BYTES: "104857601" }),
    ).toThrow("UPLOAD_MAX_BYTES must not exceed 100 MiB");
    expect(() => getUploadEnvironment({ UPLOAD_MAX_FILES: "21" })).toThrow(
      "UPLOAD_MAX_FILES must not exceed 20",
    );
  });
});

describe("getUsageEnvironment", () => {
  it("uses isolated limits only for mock test or replay modes", () => {
    expect(
      getUsageEnvironment({
        EVIANTA_USAGE_MODE: "test",
        EVIANTA_AI_PROVIDER: "mock",
      }),
    ).toMatchObject({
      mode: "test",
      modelMaxInputTokens: 32_000,
      modelMaxOutputTokens: 2_048,
    });
    expect(() =>
      getUsageEnvironment({
        EVIANTA_USAGE_MODE: "replay",
        EVIANTA_AI_PROVIDER: "muse",
      }),
    ).toThrow("Test and replay usage modes require the mock provider");
  });

  it("requires bounded spend and concurrency limits in enforced mode", () => {
    expect(() =>
      getUsageEnvironment({ EVIANTA_USAGE_MODE: "enforced" }),
    ).toThrow(
      'Required environment variable "MODEL_MAX_INPUT_TOKENS" is not set',
    );
    expect(
      getUsageEnvironment({
        EVIANTA_USAGE_MODE: "enforced",
        MODEL_MAX_INPUT_TOKENS: "32000",
        MODEL_MAX_OUTPUT_TOKENS: "2048",
        USER_MAX_CONCURRENT_RUNS: "2",
        GLOBAL_MAX_CONCURRENT_RUNS: "10",
        USER_SPEND_LIMIT_USD: "5.25",
        GLOBAL_SPEND_LIMIT_USD: "100",
        SPEND_PERIOD_SECONDS: "86400",
      }),
    ).toMatchObject({
      mode: "enforced",
      userSpendLimitUsd: 5.25,
      globalMaxConcurrentRuns: 10,
    });
    expect(() =>
      getUsageEnvironment({
        EVIANTA_USAGE_MODE: "enforced",
        MODEL_MAX_INPUT_TOKENS: "32000",
        MODEL_MAX_OUTPUT_TOKENS: "2048",
        USER_MAX_CONCURRENT_RUNS: "2",
        GLOBAL_MAX_CONCURRENT_RUNS: "10",
        USER_SPEND_LIMIT_USD: "0",
        GLOBAL_SPEND_LIMIT_USD: "100",
        SPEND_PERIOD_SECONDS: "86400",
      }),
    ).toThrow("USER_SPEND_LIMIT_USD must be a positive USD amount");
    expect(() =>
      getUsageEnvironment({
        EVIANTA_USAGE_MODE: "enforced",
        MODEL_MAX_INPUT_TOKENS: "32000",
        MODEL_MAX_OUTPUT_TOKENS: "2048",
        USER_MAX_CONCURRENT_RUNS: "2",
        GLOBAL_MAX_CONCURRENT_RUNS: "10",
        USER_SPEND_LIMIT_USD: "100000000",
        GLOBAL_SPEND_LIMIT_USD: "100",
        SPEND_PERIOD_SECONDS: "86400",
      }),
    ).toThrow("USER_SPEND_LIMIT_USD must be a positive USD amount");
  });

  it("validates usage limits when the paid provider is selected", () => {
    expect(() =>
      getAiEnvironment({
        EVIANTA_AI_PROVIDER: "muse",
        MODEL_API_KEY: "test",
        MUSE_SPARK_MODEL: "spark",
        MUSE_WONDER_MODEL: "wonder",
      }),
    ).toThrow(
      'Required environment variable "MODEL_MAX_INPUT_TOKENS" is not set',
    );
  });
});

describe("getApiEnvironment", () => {
  const configuration = {
    JWT_SIGNING_KEY: "test-only-signing-key-that-is-at-least-32-bytes",
    JWT_ISSUER: "evianta-test",
    JWT_AUDIENCE: "evianta-api-test",
    WEB_ORIGIN: "https://app.example.test",
    AUTH_RATE_LIMIT_PER_MINUTE: "10",
    API_RATE_LIMIT_PER_MINUTE: "60",
    SESSION_RECHECK_SECONDS: "30",
  };

  it("parses the required auth settings and fixed session lifetime", () => {
    expect(getApiEnvironment(configuration)).toMatchObject({
      jwtTtlSeconds: 1800,
      webOrigin: "https://app.example.test",
      apiPort: 3001,
      authRateLimitPerMinute: 10,
      apiRateLimitPerMinute: 60,
      sessionRecheckSeconds: 30,
      trustProxyHops: 0,
    });
  });

  it("rejects weak signing keys and non-origin web URLs", () => {
    expect(() =>
      getApiEnvironment({
        ...configuration,
        JWT_SIGNING_KEY: "too-short",
      }),
    ).toThrow("JWT_SIGNING_KEY must be at least 32 bytes");
    expect(() =>
      getApiEnvironment({
        ...configuration,
        WEB_ORIGIN: "https://app.example.test/path",
      }),
    ).toThrow("WEB_ORIGIN must be an exact http(s) origin");
  });

  it("rejects invalid rate limits, proxy hops, and non-30-minute lifetimes", () => {
    expect(() =>
      getApiEnvironment({
        ...configuration,
        AUTH_RATE_LIMIT_PER_MINUTE: "0",
      }),
    ).toThrow('"AUTH_RATE_LIMIT_PER_MINUTE" must be a positive integer');
    expect(() =>
      getApiEnvironment({
        ...configuration,
        TRUST_PROXY_HOPS: "-1",
      }),
    ).toThrow("TRUST_PROXY_HOPS must be a non-negative integer");
    expect(() =>
      getApiEnvironment({
        ...configuration,
        JWT_TTL_SECONDS: "3600",
      }),
    ).toThrow("JWT_TTL_SECONDS must be 1800");
  });
});
