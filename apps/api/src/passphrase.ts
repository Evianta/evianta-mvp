import { createHmac } from "node:crypto";
import type { AccessKeyRecord } from "@evianta/core";

const PASSPHRASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 64;

export function isLegacyAccessKey(value: string): boolean {
  return /^evk_/.test(value.trim());
}

/** Case, spacing and separators do not matter when someone types a key. */
export function normalizePassphrase(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_.-]+/g, "-");
  if (
    normalized.length < MIN_PASSPHRASE_LENGTH ||
    normalized.length > MAX_PASSPHRASE_LENGTH ||
    !PASSPHRASE_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function derive(pepper: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", pepper).update(`${purpose}:${value}`).digest();
}

export function passphraseKeyId(pepper: string, normalized: string): string {
  return `pp_${derive(pepper, "id", normalized).toString("base64url").slice(0, 24)}`;
}

export function passphraseKeyHash(pepper: string, normalized: string): string {
  return derive(pepper, "hash", normalized).toString("hex");
}

export function createPassphraseAccessKey(input: {
  userId: string;
  pepper: string;
  expiresAt: string;
  passphrase: string;
  now?: Date;
}): { record: AccessKeyRecord; plaintext: string } {
  const now = input.now ?? new Date();
  if (Date.parse(input.expiresAt) <= now.getTime()) {
    throw new Error("Access-key expiry must be in the future");
  }
  const plaintext = normalizePassphrase(input.passphrase);
  if (!plaintext) {
    throw new Error(
      `A custom code needs ${MIN_PASSPHRASE_LENGTH} to ${MAX_PASSPHRASE_LENGTH} letters, digits or dashes`,
    );
  }
  const id = passphraseKeyId(input.pepper, plaintext);
  return {
    record: {
      id,
      userId: input.userId,
      keyHash: passphraseKeyHash(input.pepper, plaintext),
      keyPrefix: id.slice(0, 9),
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: now.toISOString(),
    },
    plaintext,
  };
}
