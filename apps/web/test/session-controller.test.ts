import { describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_AGE_MS,
  SessionController,
} from "../src/session/session-controller.js";

describe("SessionController", () => {
  it("keeps the session in memory and expires it within thirty minutes", () => {
    let now = 1_000;
    const controller = new SessionController(() => now);
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setSession("memory-only-token", now + MAX_SESSION_AGE_MS * 2);

    expect(controller.getToken()).toBe("memory-only-token");
    expect(controller.getSnapshot()?.expiresAt).toBe(now + MAX_SESSION_AGE_MS);
    now += MAX_SESSION_AGE_MS + 1;
    expect(controller.getToken()).toBeNull();
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clears sensitive session state on logout and rejects expired tokens", () => {
    let now = 5_000;
    const controller = new SessionController(() => now);
    controller.setSession("short-token", now + 100);
    now += 101;
    expect(controller.getToken()).toBeNull();
    expect(() => controller.setSession("expired-token", now)).toThrow(
      "The access token is already expired.",
    );
    expect(controller.getSnapshot()).toBeNull();
  });
});
