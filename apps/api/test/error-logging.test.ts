import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createInMemoryStore } from "../../../packages/store/src/memory.js";
import { DocumentStoreError } from "../../../packages/store/src/document-errors.js";
import { createApiApp } from "../src/app.js";
import { getErrorLogDetails } from "../src/error-logging.js";

describe("startup error logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("API request error logging", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it.each([
      ["s3-write-failed", "AccessDenied", "AccessDenied"],
      ["write-failed", "Error", "EACCES"],
    ])(
      "logs %s with its underlying cause and request ID without exposing secrets",
      async (code, causeName, causeCode) => {
        vi.stubEnv("AWS_ACCESS_KEY_ID", "test-aws-access-key");
        vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-key");
        vi.stubEnv("AWS_SESSION_TOKEN", "test-aws-session-token");
        const cause = Object.assign(
          new Error(
            "Upload rejected: test-aws-access-key test-aws-secret-key test-aws-session-token",
          ),
          { name: causeName, code: causeCode },
        );
        const error = new DocumentStoreError("Document upload failed", code, {
          cause,
        });
        error.name = "DocumentStoreError test-aws-access-key";
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const { app } = createApiApp({
          repositories: createInMemoryStore().repositories,
          configuration: {
            jwtSigningKey: "a-test-only-signing-key-that-is-at-least-32-bytes",
            jwtIssuer: "evianta-test",
            jwtAudience: "evianta-api-test",
            jwtTtlSeconds: 1800,
            authRateLimitPerMinute: 10,
            apiRateLimitPerMinute: 60,
            webOrigin: "https://app.example.test",
            trustProxyHops: 0,
            sessionRecheckSeconds: 30,
          },
          registerRoutes: ({ app }) => {
            app.post("/test-upload", (_request, _response, next) =>
              next(error),
            );
          },
        });
        const server = app.listen(0, "127.0.0.1");
        try {
          await once(server, "listening");
          const address = server.address() as AddressInfo;
          const response = await fetch(
            `http://127.0.0.1:${address.port}/test-upload`,
            { method: "POST" },
          );
          expect(response.status).toBe(500);
          const body = await response.json();
          expect(body).toEqual({
            error: {
              code: "internal-error",
              message: "An unexpected error occurred",
              requestId: response.headers.get("x-request-id"),
              details: [],
            },
          });
          expect(log).toHaveBeenCalledExactlyOnceWith(
            "API request failed",
            expect.objectContaining({
              method: "POST",
              requestId: response.headers.get("x-request-id"),
              errorName: "DocumentStoreError [REDACTED]",
              error: expect.objectContaining({
                name: "DocumentStoreError [REDACTED]",
                code,
                cause: expect.objectContaining({
                  name: causeName,
                  code: causeCode,
                  message: "Upload rejected: [REDACTED] [REDACTED] [REDACTED]",
                }),
              }),
            }),
          );
          const logged = JSON.stringify(log.mock.calls);
          expect(logged).not.toContain("test-aws-access-key");
          expect(logged).not.toContain("test-aws-secret-key");
          expect(logged).not.toContain("test-aws-session-token");
        } finally {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    );
  });

  it("includes causes and stack details while redacting configured secrets", () => {
    vi.stubEnv("MODEL_API_KEY", "local-model-secret");
    const error = new Error("Connection failed with local-model-secret", {
      cause: new Error("Underlying request failed"),
    });

    const details = getErrorLogDetails(error);

    expect(details.message).toBe("Connection failed with [REDACTED]");
    expect(details.stack).toContain("[REDACTED]");
    expect(details.cause).toMatchObject({
      message: "Underlying request failed",
    });
    expect(JSON.stringify(details)).not.toContain("local-model-secret");
  });

  it("includes redacted aggregate upload and cleanup errors", () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-aws-secret-key");
    const uploadError = Object.assign(
      new Error("Upload failed with test-aws-secret-key"),
      { code: "EACCES" },
    );
    const cleanupError = Object.assign(
      new Error("Cleanup failed with test-aws-secret-key"),
      { code: "EPERM" },
    );
    const error = new AggregateError(
      [uploadError, new AggregateError([cleanupError], "Cleanup failures")],
      "Document upload failed and temporary files could not be removed",
    );

    const details = getErrorLogDetails(error);

    expect(details).toMatchObject({
      name: "AggregateError",
      errors: [
        { code: "EACCES", message: "Upload failed with [REDACTED]" },
        {
          errors: [
            { code: "EPERM", message: "Cleanup failed with [REDACTED]" },
          ],
        },
      ],
    });
    expect(JSON.stringify(details)).not.toContain("test-aws-secret-key");
  });

  it("redacts names in circular causes and aggregate members", () => {
    vi.stubEnv("MODEL_API_KEY", "local-model-secret");
    const error = new AggregateError([], "Circular failure");
    error.name = "Failure local-model-secret";
    error.cause = error;
    error.errors.push(error);

    const details = getErrorLogDetails(error);

    expect(details).toMatchObject({
      name: "Failure [REDACTED]",
      cause: {
        name: "Failure [REDACTED]",
        message: "[Circular cause]",
      },
      errors: [{ name: "Failure [REDACTED]", message: "[Circular cause]" }],
    });
    expect(JSON.stringify(details)).not.toContain("local-model-secret");
  });

  it("bounds recursion across aggregate members and causes", () => {
    let error: Error = new Error("Beyond depth limit");
    for (let depth = 5; depth >= 0; depth -= 1) {
      error =
        depth % 2 === 0
          ? new AggregateError([error], `Level ${depth}`)
          : new Error(`Level ${depth}`, { cause: error });
    }

    const details = getErrorLogDetails(error);

    expect(details).toMatchObject({
      errors: [
        {
          cause: {
            errors: [
              {
                cause: {
                  errors: [{ message: "Level 5" }],
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(details)).not.toContain("Beyond depth limit");
  });
});
