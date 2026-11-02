import { describe, expect, it } from "vitest";
import { AuthenticationService, createUserAccessKey } from "../src/auth.js";
import {
  createPassphraseAccessKey,
  normalizePassphrase,
} from "../src/passphrase.js";
import { createInMemoryStore } from "../../../packages/store/src/memory.js";

const pepper = "a-separate-pepper-that-is-at-least-32-bytes";
const configuration = {
  jwtSigningKey: "a-test-only-signing-key-that-is-at-least-32-bytes",
  jwtIssuer: "evianta-test",
  jwtAudience: "evianta-api-test",
  jwtTtlSeconds: 28800,
  authRateLimitPerMinute: 10,
  apiRateLimitPerMinute: 60,
};
const now = new Date("2026-10-28T00:00:00.000Z");
const timestamp = "2026-10-28T00:00:00.000Z";
const code = "Jury Amber Falcon 47";

function issue(
  overrides: Partial<Parameters<typeof createPassphraseAccessKey>[0]> = {},
) {
  return createPassphraseAccessKey({
    userId: "juror-1",
    pepper,
    expiresAt: "2026-11-30T00:00:00.000Z",
    passphrase: code,
    now,
    ...overrides,
  });
}

async function setup(withPepper = true) {
  const { repositories } = createInMemoryStore();
  await repositories.users.insert({
    id: "juror-1",
    email: "juror-1@example.test",
    displayName: "Juror One",
    role: "user",
    disabledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const service = new AuthenticationService(
    repositories,
    withPepper ? { ...configuration, accessKeyPepper: pepper } : configuration,
    () => now,
  );
  return { repositories, service };
}

describe("administrator-chosen access codes", () => {
  it("normalizes case, spaces and separators and enforces a sensible shape", () => {
    expect(normalizePassphrase("  Jury Amber_falcon.47 ")).toBe(
      "jury-amber-falcon-47",
    );
    expect(normalizePassphrase("short")).toBeNull();
    expect(normalizePassphrase("x".repeat(65))).toBeNull();
    expect(normalizePassphrase("emoji-code-\u{1F600}")).toBeNull();
    expect(normalizePassphrase("Evianta Jury")).toBe("evianta-jury");
  });

  it("stores only a peppered hash and rejects weak codes or past expiry", () => {
    const issued = issue();
    expect(issued.plaintext).toBe("jury-amber-falcon-47");
    expect(JSON.stringify(issued.record)).not.toContain(issued.plaintext);
    expect(() => issue({ passphrase: "abc" })).toThrow();
    expect(() => issue({ expiresAt: "2026-10-01T00:00:00.000Z" })).toThrow(
      "future",
    );
  });

  it("exchanges a typed code for the configured session length", async () => {
    const { repositories, service } = await setup();
    await repositories.accessKeys.insert(issue().record);
    const result = await service.exchangeAccessKey("JURY AMBER falcon 47");
    expect(result).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 28800,
      expiresAt: "2026-10-28T08:00:00.000Z",
    });
  });

  it("rejects wrong, revoked and unpeppered codes", async () => {
    const { repositories, service } = await setup();
    const issued = issue();
    await repositories.accessKeys.insert(issued.record);

    expect(await service.exchangeAccessKey("not-the-right-code")).toBeNull();
    expect(await service.exchangeAccessKey(42)).toBeNull();
    expect(await service.exchangeAccessKey("x".repeat(300))).toBeNull();

    const other = issue({
      pepper: "another-pepper-that-is-also-32-bytes-long",
      passphrase: "other-code-1234",
    });
    await repositories.accessKeys.insert(other.record);
    expect(await service.exchangeAccessKey(other.plaintext)).toBeNull();
    expect(
      await (await setup(false)).service.exchangeAccessKey(issued.plaintext),
    ).toBeNull();

    await repositories.accessKeys.revoke(issued.record.id, timestamp);
    expect(await service.exchangeAccessKey(issued.plaintext)).toBeNull();
  });

  it("stops working at expiry and for disabled users", async () => {
    const { repositories } = await setup();
    await repositories.accessKeys.insert(
      issue({ expiresAt: "2026-10-28T00:00:01.000Z" }).record,
    );
    const later = new AuthenticationService(
      repositories,
      { ...configuration, accessKeyPepper: pepper },
      () => new Date("2026-10-28T00:01:00.000Z"),
    );
    expect(await later.exchangeAccessKey(code)).toBeNull();

    const fresh = await setup();
    await fresh.repositories.accessKeys.insert(issue().record);
    const user = await fresh.repositories.users.findById("juror-1");
    await fresh.repositories.users.replace({
      ...user!,
      disabledAt: timestamp,
      updatedAt: timestamp,
    });
    expect(await fresh.service.exchangeAccessKey(code)).toBeNull();
  });

  it("keeps legacy keys working with or without a pepper", async () => {
    const { repositories, service } = await setup();
    const legacy = createUserAccessKey("juror-1", null, now);
    await repositories.accessKeys.insert(legacy.record);
    expect(await service.exchangeAccessKey(legacy.plaintext)).not.toBeNull();
    expect(
      await (await setup(false)).service.exchangeAccessKey("evk_bad.key"),
    ).toBeNull();
  });
});
