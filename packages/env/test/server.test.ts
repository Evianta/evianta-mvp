import { describe, expect, it } from "vitest";

import {
  getAiEnvironment,
  getMongoConfig,
  getRequiredEnv,
  getUsageEnvironment,
} from "../src/server.js";

describe("getRequiredEnv", () => {
  it("returns a configured value", () => {
    expect(
      getRequiredEnv("DATABASE_URL", { DATABASE_URL: "mongodb://local" }),
    ).toBe("mongodb://local");
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
