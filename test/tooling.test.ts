import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  getAiEnvironment,
  getApiEnvironment,
  getDocumentStoreConfig,
  getMongoConfig,
  getRequiredEnv,
  getUploadEnvironment,
} from "../packages/env/src/server.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

describe("developer tooling", () => {
  it("deploys Node entrypoints without PM2's import wrapper", async () => {
    const workflow = await readFile(
      join(root, ".github", "workflows", "deploy.yml"),
      "utf8",
    );
    expect(workflow).toContain('node_bin="$(command -v node)"');
    expect(workflow).toContain("options=(--interpreter none");
    expect(workflow.match(/pm2 start "\$node_bin"/g)).toHaveLength(3);
    for (const entrypoint of [
      "$root/apps/api/dist/server.js",
      "$root/apps/api/dist/worker.js",
      "$root/apps/web/node_modules/next/dist/bin/next",
    ]) {
      expect(workflow).toContain(`-- "--env-file=$root/.env" "${entrypoint}"`);
    }
  });

  it("provides valid local defaults without environment overrides", async () => {
    const example = parseEnv(
      await readFile(join(root, ".env.example"), "utf8"),
    );
    const environment = getApiEnvironment(example);
    expect(environment.jwtSigningKey).toBe(example.JWT_SIGNING_KEY);
    expect(Buffer.byteLength(environment.jwtSigningKey)).toBeGreaterThanOrEqual(
      32,
    );
    expect(getMongoConfig(example)).toEqual({
      uri: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
      dbName: "evianta",
    });
    expect(getDocumentStoreConfig(example)).toEqual({
      driver: "filesystem",
      localStorageDir: ".data/documents",
    });
    expect(getUploadEnvironment(example)).toEqual({
      uploadMaxBytes: 26_214_400,
      uploadMaxFiles: 10,
      documentMaxPages: 100,
    });
    expect(getAiEnvironment(example)).toMatchObject({
      provider: "mock",
      usage: { mode: "test" },
    });
    expect(environment.apiPort).toBe(3001);
    expect(example.NEXT_PUBLIC_API_BASE_URL).toBe("http://localhost:3001");
    expect(
      new URL(getRequiredEnv("NEXT_PUBLIC_API_BASE_URL", example)).port,
    ).toBe(String(environment.apiPort));
    expect(environment.webOrigin).toBe("http://localhost:3000");
    expect(example.EVIANTA_AI_PROVIDER).toBe("mock");
    expect(example.EVIANTA_USAGE_MODE).toBe("test");
  });

  it("loads root environment values for every web entrypoint without overriding exported values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evianta-web-env-"));
    const app = join(directory, "apps", "web");
    try {
      await mkdir(app, { recursive: true });
      await writeFile(
        join(directory, ".env"),
        "NEXT_PUBLIC_API_BASE_URL=http://localhost:3001\nNODE_ENV=development\n",
      );
      const manifest: { scripts: Record<string, string> } = JSON.parse(
        await readFile(join(root, "apps", "web", "package.json"), "utf8"),
      );
      await writeFile(join(app, "package.json"), JSON.stringify(manifest));
      const nextBin = join(app, "node_modules", "next", "dist", "bin");
      await mkdir(nextBin, { recursive: true });
      await writeFile(
        join(nextBin, "next"),
        "console.log(JSON.stringify({ url: process.env.NEXT_PUBLIC_API_BASE_URL, mode: process.env.NODE_ENV })); process.exitCode = Number(process.env.FIXTURE_EXIT_CODE || 0);",
      );
      const env = { ...process.env };
      delete env.NEXT_PUBLIC_API_BASE_URL;
      delete env.NODE_ENV;
      delete env.FIXTURE_EXIT_CODE;
      for (const script of ["dev:server", "build", "start"]) {
        const { stdout } = await execute(process.execPath, ["--run", script], {
          cwd: app,
          env,
        });
        expect(JSON.parse(stdout.trim())).toEqual({
          url: "http://localhost:3001",
          mode: script === "dev:server" ? "development" : "production",
        });
      }
      const { stdout } = await execute(process.execPath, ["--run", "build"], {
        cwd: app,
        env: {
          ...env,
          NODE_ENV: "production",
          NEXT_PUBLIC_API_BASE_URL: "https://api.example.test",
        },
      });
      expect(JSON.parse(stdout.trim())).toEqual({
        url: "https://api.example.test",
        mode: "production",
      });
      await expect(
        execute(process.execPath, ["--run", "dev:server"], {
          cwd: app,
          env: { ...env, FIXTURE_EXIT_CODE: "7" },
        }),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
