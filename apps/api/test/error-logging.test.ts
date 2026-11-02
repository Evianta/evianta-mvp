import { afterEach, describe, expect, it, vi } from "vitest";
import { getErrorLogDetails } from "../src/error-logging.js";

describe("startup error logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
