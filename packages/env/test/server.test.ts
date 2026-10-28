import { describe, expect, it } from "vitest";

import {
  getApiEnvironment,
  getMongoConfig,
  getRequiredEnv,
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
