import { describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_AGE_MS,
  SESSION_STORAGE_KEY,
  SessionController,
} from "../src/session/session-controller.js";

describe("SessionController", () => {
  function storage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
  }

  it("persists only the token and absolute expiry and restores without renewing it", () => {
    const saved = storage();
    let now = 1000;
    const first = new SessionController(() => now);
    first.restore(saved);
    first.setSession("saved-token", now + MAX_SESSION_AGE_MS);
    expect(JSON.parse(saved.getItem(SESSION_STORAGE_KEY)!)).toEqual({
      accessToken: "saved-token",
      expiresAt: 1000 + MAX_SESSION_AGE_MS,
    });
    now += 60000;
    const second = new SessionController(() => now);
    second.restore(saved);
    expect(second.getSnapshot()).toEqual(first.getSnapshot());
    second.clear();
    expect(saved.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it.each([
    "",
    "{",
    "null",
    '{"accessToken":1,"expiresAt":5000}',
    '{"accessToken":"token","expiresAt":"5000"}',
    '{"accessToken":"token","expiresAt":999999999}',
  ])(
    "removes malformed saved sessions (%s) and reports the failure",
    (value) => {
      const saved = storage();
      saved.setItem(SESSION_STORAGE_KEY, value);
      const controller = new SessionController(() => 1000);
      expect(() => controller.restore(saved)).toThrow(
        "Saved sign-in is invalid",
      );
      expect(controller.getSnapshot()).toBeNull();
      expect(saved.getItem(SESSION_STORAGE_KEY)).toBeNull();
    },
  );

  it("removes expired saved sessions on restore and active sessions on expiry", () => {
    const saved = storage();
    let now = 1000;
    saved.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "expired", expiresAt: now }),
    );
    const controller = new SessionController(() => now);
    controller.restore(saved);
    expect(saved.getItem(SESSION_STORAGE_KEY)).toBeNull();
    controller.setSession("valid", now + 100);
    now += 101;
    expect(controller.getToken()).toBeNull();
    expect(saved.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("surfaces storage failures instead of claiming persistent login or successful cleanup", () => {
    const saved = storage();
    const controller = new SessionController(() => 1000);
    controller.restore(saved);
    saved.setItem = () => {
      throw new Error("Quota exceeded");
    };
    expect(() => controller.setSession("token", 2000)).toThrow(
      "Quota exceeded",
    );
    expect(controller.getSnapshot()).toBeNull();
    const working = storage();
    controller.setSession("token", 2000, working);
    working.removeItem = () => {
      throw new Error("Storage blocked");
    };
    expect(() => controller.clear()).toThrow("Storage blocked");
    expect(controller.getSnapshot()).toBeNull();
  });
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

  it("only clears the persisted session when its token still matches", () => {
    const saved = storage();
    const controller = new SessionController(() => 1000);
    controller.restore(saved);
    controller.setSession("session-a", 2000);
    controller.clearIfToken("session-a");
    controller.setSession("session-b", 3000);

    controller.clearIfToken("session-a");

    expect(controller.getToken()).toBe("session-b");
    expect(JSON.parse(saved.getItem(SESSION_STORAGE_KEY)!)).toMatchObject({
      accessToken: "session-b",
    });
  });
});
