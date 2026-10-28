import { randomUUID } from "node:crypto";
import type { UserRecord } from "@evianta/core";
import { connectMongoStore } from "@evianta/store";
import { createUserAccessKey } from "./auth.js";

function usage(): never {
  throw new Error(
    "Usage: admin <create-user|disable-user|issue-key|revoke-key> <arguments>",
  );
}

async function main(args: string[]): Promise<void> {
  const [command, ...values] = args;
  if (!command) usage();
  const store = await connectMongoStore();
  try {
    const { users, accessKeys } = store.repositories;
    const now = new Date().toISOString();
    switch (command) {
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
