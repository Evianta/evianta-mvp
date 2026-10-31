import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForOutput(
  child: ChildProcess,
  readOutput: () => string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  if (readOutput().includes(expected)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Process did not report "${expected}"`)),
      timeoutMs,
    );
    const check = () => {
      if (!readOutput().includes(expected)) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout?.on("data", check);
    child.stderr?.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Process exited before startup (code ${code})`));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("API health check did not become ready");
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

describe("production process entrypoints", () => {
  it("explains admin arguments before connecting to MongoDB", async () => {
    for (const args of [
      ["issue-key"],
      ["create-user"],
      ["disable-user"],
      ["revoke-key"],
      ["unknown-command"],
    ]) {
      await expect(
        promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL("../dist/admin.js", import.meta.url)),
            ...args,
          ],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, MONGODB_URI: "invalid-uri", MONGODB_DB: "" },
            timeout: 30_000,
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("issue-key <user-id>"),
      });
    }
  }, 180_000);

  it("reports missing configuration before connecting to the database", async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, JWT_SIGNING_KEY: "" },
          timeout: 30_000,
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("JWT_SIGNING_KEY"),
    });
  }, 45_000);

  it("starts the API and independent worker against a local MongoDB", async () => {
    const mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
    });
    const storageDir = await mkdtemp(join(tmpdir(), "evianta-api-smoke-"));
    const port = await freePort();
    const appDirectory = fileURLToPath(new URL("..", import.meta.url));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      MONGODB_URI: mongo.getUri("evianta_api_smoke"),
      MONGODB_DB: "evianta_api_smoke",
      JWT_SIGNING_KEY: "smoke-test-signing-key-with-at-least-32-bytes",
      JWT_ISSUER: "evianta-smoke",
      JWT_AUDIENCE: "evianta-smoke-api",
      WEB_ORIGIN: "http://localhost:3000",
      API_PORT: String(port),
      AUTH_RATE_LIMIT_PER_MINUTE: "20",
      API_RATE_LIMIT_PER_MINUTE: "60",
      SESSION_RECHECK_SECONDS: "30",
      TRUST_PROXY_HOPS: "0",
      EVIANTA_AI_PROVIDER: "mock",
      EVIANTA_USAGE_MODE: "test",
      DOCUMENT_STORE: "filesystem",
      LOCAL_STORAGE_DIR: storageDir,
    };
    let api: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    try {
      api = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
        { cwd: appDirectory, env: environment },
      );
      await waitForHealth(port, api);

      worker = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/worker.js", import.meta.url))],
        { cwd: appDirectory, env: environment },
      );
      let output = "";
      worker.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      worker.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await waitForOutput(
        worker,
        () => output,
        "Evianta worker started",
        30_000,
      );
      expect(worker.exitCode).toBeNull();
    } finally {
      await stopChild(worker);
      await stopChild(api);
      await mongo.stop();
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("rejects standalone MongoDB before starting usage recovery or the worker", async () => {
    const mongo = await MongoMemoryServer.create();
    try {
      await expect(
        promisify(execFile)(
          process.execPath,
          [fileURLToPath(new URL("../dist/worker.js", import.meta.url))],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: {
              ...process.env,
              MONGODB_URI: mongo.getUri(),
              MONGODB_DB: "standalone_rejected",
              DOCUMENT_STORE: "filesystem",
              LOCAL_STORAGE_DIR: ".data/test",
              EVIANTA_AI_PROVIDER: "mock",
              EVIANTA_USAGE_MODE: "test",
            },
            timeout: 30_000,
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("mongodb-transactions-required"),
        stdout: expect.not.stringContaining("Evianta worker started"),
      });
    } finally {
      await mongo.stop();
    }
  }, 60_000);
});
