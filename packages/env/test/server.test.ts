import { describe, expect, it } from "vitest";

import { getMongoConfig, getRequiredEnv } from "../src/server.js";

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
    for (const dbName of ["a/b", "a b", "a.b", "a$b", "a".repeat(64)]) {
      expect(() =>
        getMongoConfig({
          MONGODB_URI: "mongodb://localhost:27017",
          MONGODB_DB: dbName,
        }),
      ).toThrow("MONGODB_DB must be a valid MongoDB database name");
    }
  });
});
