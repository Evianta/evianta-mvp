import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("production Next.js configuration", () => {
  it.each([
    ["0", ".next"],
    ["1", ".next-e2e"],
  ])("loads without TypeScript when EVIANTA_E2E=%s", (e2e, distDir) => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `
          const assert = require("node:assert/strict");
          const Module = require("node:module");
          const resolveFilename = Module._resolveFilename;
          Module._resolveFilename = function (request, ...args) {
            if (request === "typescript" || request.startsWith("typescript/")) {
              throw new Error("Production configuration must not load TypeScript");
            }
            return resolveFilename.call(this, request, ...args);
          };
          const loadConfig = require("next/dist/server/config").default;
          loadConfig("phase-production-server", process.cwd()).then(config => {
            assert.equal(config.configFileName, "next.config.mjs");
            assert.equal(config.poweredByHeader, false);
            assert.equal(config.distDir, process.env.EXPECTED_DIST_DIR);
          }).catch(error => {
            console.error(error);
            process.exitCode = 1;
          });
        `,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: {
          ...process.env,
          NODE_ENV: "production",
          EVIANTA_E2E: e2e,
          EXPECTED_DIST_DIR: distDir,
        },
        encoding: "utf8",
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
