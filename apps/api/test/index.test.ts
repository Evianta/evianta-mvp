import { afterEach, describe, expect, it, vi } from "vitest";
import { startApi } from "../src/index.js";

describe("API startup diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("logs safe configuration validation details", async () => {
    vi.stubEnv("JWT_SIGNING_KEY", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startApi()).rejects.toThrow(
      'Required environment variable "JWT_SIGNING_KEY" is not set',
    );
    expect(log).toHaveBeenCalledWith("API configuration invalid", {
      message: 'Required environment variable "JWT_SIGNING_KEY" is not set',
    });
  });
});
