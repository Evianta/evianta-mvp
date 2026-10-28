import { describe, expect, it } from "vitest";

import {
  getMongoDatabaseName,
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
      expect(
        getMongoDbUri({
          MONGODB_URI: "mongodb://db1:27017,db2:27017/evianta?replicaSet=rs0",
        }),
      ).toBe("mongodb://db1:27017,db2:27017/evianta?replicaSet=rs0");
      expect(() =>
        getMongoDbUri({ MONGODB_URI: "mongodb://localhost:27017/" }),
      ).toThrow("MONGODB_URI must include a database name");
    });

    it("extracts database names from replica-set seed lists", () => {
      expect(
        getMongoDatabaseName(
          "mongodb://db1:27017,db2:27017/evianta?replicaSet=rs0",
        ),
      ).toBe("evianta");
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

  it("rejects a missing or blank value", () => {
    expect(() => getRequiredEnv("DATABASE_URL", {})).toThrow(
      'Required environment variable "DATABASE_URL" is not set',
    );
    expect(() =>
      getRequiredEnv("DATABASE_URL", { DATABASE_URL: "  " }),
    ).toThrow('Required environment variable "DATABASE_URL" is not set');
  });
});
