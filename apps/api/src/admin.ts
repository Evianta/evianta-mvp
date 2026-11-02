import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { UserRecord } from "@evianta/core";
import { getAccessKeyPepper } from "@evianta/env/server";
import { connectMongoStore } from "@evianta/store";
import { createUserAccessKey } from "./auth.js";
import { createPassphraseAccessKey } from "./passphrase.js";
import { parseUsagePrice } from "./usage-price.js";

function usage(): never {
  throw new Error(
    "Usage: admin create-user <email> <display-name> [user|admin] | disable-user <user-id> | issue-key <user-id> [expiry-ISO] [--code <your-own-code>] | revoke-key <key-id> | import-price <json-file>",
  );
}

function takeFlag(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) usage();
  values.splice(index, 2);
  return value;
}

async function main(args: string[]): Promise<void> {
  const [command, ...values] = args;
  const code = command === "issue-key" ? takeFlag(values, "--code") : undefined;
  switch (command) {
    case "create-user":
      if (
        !values[0]?.trim() ||
        !values[1]?.trim() ||
        values.length > 3 ||
        (values[2] !== undefined &&
          values[2] !== "user" &&
          values[2] !== "admin")
      )
        usage();
      break;
    case "issue-key":
      if (!values[0]?.trim() || values.length > 2) usage();
      if (code !== undefined && !values[1]?.trim()) usage();
      break;
    case "disable-user":
    case "revoke-key":
    case "import-price":
      if (!values[0]?.trim() || values.length !== 1) usage();
      break;
    default:
      usage();
  }
  const pricePath = values[0];
  const price =
    command === "import-price" && pricePath
      ? parseUsagePrice(JSON.parse(await readFile(pricePath, "utf8")))
      : undefined;
  const store = await connectMongoStore();
  try {
    const { users, accessKeys } = store.repositories;
    const now = new Date().toISOString();
    switch (command) {
      case "import-price": {
        if (!price) usage();
        await store.repositories.usagePrices.insert(price);
        console.info(
          `Imported price ${price.id} for ${price.provider}:${price.model} (settings ${price.settingsKey}, version ${price.version}, effective ${price.effectiveAt})`,
        );
        break;
      }
      case "create-user": {
        const [email, displayName] = values;
        const roleInput = values[2];
        if (!email || !displayName) usage();
        if (
          roleInput !== undefined &&
          roleInput !== "user" &&
          roleInput !== "admin"
        ) {
          usage();
        }
        const role = roleInput === "admin" ? "admin" : "user";
        const user: UserRecord = {
          id: randomUUID(),
          email: email.trim().toLowerCase(),
          displayName: displayName.trim(),
          role,
          disabledAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await users.insert(user);
        console.info(`Created user ${user.id}`);
        break;
      }
      case "disable-user": {
        const [userId] = values;
        if (!userId) usage();
        const user = await users.findById(userId);
        if (!user) throw new Error("User was not found");
        await users.replace({ ...user, disabledAt: now, updatedAt: now });
        console.info(`Disabled user ${user.id}`);
        break;
      }
      case "issue-key": {
        const [userId, expiry] = values;
        if (!userId) usage();
        const user = await users.findById(userId);
        if (!user || user.disabledAt !== null) {
          throw new Error("An enabled user is required");
        }
        const expiresAt = expiry ? new Date(expiry).toISOString() : null;
        if (code !== undefined) {
          if (expiresAt === null) usage();
          const issued = createPassphraseAccessKey({
            userId: user.id,
            pepper: getAccessKeyPepper(),
            expiresAt,
            passphrase: code,
          });
          await accessKeys.insert(issued.record);
          process.stdout.write(`${issued.plaintext}\n`);
          break;
        }
        const { record, plaintext } = createUserAccessKey(user.id, expiresAt);
        await accessKeys.insert(record);
        process.stdout.write(`${plaintext}\n`);
        break;
      }
      case "revoke-key": {
        const [keyId] = values;
        if (!keyId) usage();
        if (!(await accessKeys.revoke(keyId, now))) {
          throw new Error("Active access key was not found");
        }
        console.info(`Revoked access key ${keyId}`);
        break;
      }
      default:
        usage();
    }
  } finally {
    await store.close();
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown administrative error";
  console.error(`Admin command failed: ${message}`);
  process.exitCode = 1;
});
