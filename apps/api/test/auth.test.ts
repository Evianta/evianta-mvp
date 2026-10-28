import { CaseSchema, syntheticWorkflowFixtures } from "@evianta/core";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import {
  AuthenticationService,
  bearerToken,
  createUserAccessKey,
  requireAdmin,
  requireCaseOwner,
  type AuthContext,
} from "../src/auth.js";
import { createInMemoryStore } from "../../../packages/store/src/memory.js";

const signingKey = "a-test-only-signing-key-that-is-at-least-32-bytes";
const issuer = "evianta-test";
const audience = "evianta-api-test";
const webOrigin = "https://app.example.test";

type RequestWithAuth = Request & { authContext?: AuthContext };

function createUser(
  id = "user-1",
  role: "user" | "admin" = "user",
  overrides: { disabledAt?: string | null } = {},
) {
  const timestamp = "2026-10-28T00:00:00.000Z";
  return {
    id,
    email: `${id}@example.test`,
    displayName: "Test User",
    role,
    disabledAt: overrides.disabledAt ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function listen(app: express.Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("The test server did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("API access-key authentication", () => {
  let repositories: ReturnType<typeof createInMemoryStore>["repositories"];
  let now: Date;
  let accessKey: ReturnType<typeof createUserAccessKey>;
  let service: AuthenticationService;
  let close: () => Promise<void>;
  let baseUrl: string;

  beforeEach(async () => {
    const store = createInMemoryStore();
    repositories = store.repositories;
    now = new Date("2026-10-28T00:00:00.000Z");
    await repositories.users.insert(createUser());
    accessKey = createUserAccessKey("user-1", null, now);
    await repositories.accessKeys.insert(accessKey.record);
    const configuration = {
      jwtSigningKey: signingKey,
      jwtIssuer: issuer,
      jwtAudience: audience,
      jwtTtlSeconds: 1800 as const,
      authRateLimitPerMinute: 10,
      apiRateLimitPerMinute: 60,
      webOrigin,
      trustProxyHops: 0,
      sessionRecheckSeconds: 30,
    };
    service = new AuthenticationService(repositories, configuration, () => now);
    const { app } = createApiApp({
      repositories,
      configuration,
      now: () => now,
    });
    const server = await listen(app);
    baseUrl = server.baseUrl;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  async function exchange(key: string) {
    return fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: key }),
    });
  }

  async function me(token: string) {
    return fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("exchanges a key for a short-lived token without persisting the key", async () => {
    const response = await exchange(accessKey.plaintext);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tokenResult = (await response.json()) as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
    };
    expect(tokenResult).toMatchObject({
      tokenType: "Bearer",
      expiresIn: 1800,
    });
    expect(tokenResult.accessToken).not.toContain(accessKey.plaintext);

    const storedKey = await repositories.accessKeys.findActiveById(
      accessKey.record.id,
      now.toISOString(),
    );
    expect(storedKey).toMatchObject({
      keyHash: createHash("sha256").update(accessKey.plaintext).digest("hex"),
      lastUsedAt: now.toISOString(),
    });
    expect(storedKey?.keyHash).not.toBe(accessKey.plaintext);

    const meResponse = await me(tokenResult.accessToken);
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toEqual({
      user: {
        id: "user-1",
        email: "user-1@example.test",
        displayName: "Test User",
        role: "user",
      },
      session: { expiresAt: "2026-10-28T00:30:00.000Z" },
    });
  });

  it("returns generic exchange errors and throttles a source before key lookup", async () => {
    const limited = createApiApp({
      repositories,
      configuration: {
        jwtSigningKey: signingKey,
        jwtIssuer: issuer,
        jwtAudience: audience,
        jwtTtlSeconds: 1800,
        authRateLimitPerMinute: 2,
        apiRateLimitPerMinute: 60,
        webOrigin,
        trustProxyHops: 0,
        sessionRecheckSeconds: 30,
      },
      now: () => now,
    });
    await close();
    const server = await listen(limited.app);
    close = server.close;
    baseUrl = server.baseUrl;

    const malformed = await fetch(`${baseUrl}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const first = await exchange("not-an-access-key");
    const second = await exchange("not-an-access-key");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: "invalid_request", message: "Request body is invalid" },
    });
    expect(first.status).toBe(401);
    expect(await first.json()).toEqual({
      error: { code: "invalid_credentials", message: "Access key is invalid" },
    });
    expect(second.status).toBe(429);
  });

  it("rejects malformed signatures, logs out sessions, and rechecks key revocation", async () => {
    const exchangeResponse = await exchange(accessKey.plaintext);
    const { accessToken } = (await exchangeResponse.json()) as {
      accessToken: string;
    };
    const segments = accessToken.split(".");
    const signature = segments[2];
    if (!signature) throw new Error("Token signature is missing");
    segments[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;

    expect((await me(segments.join("."))).status).toBe(401);
    expect((await me(accessToken)).status).toBe(200);

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logout.status).toBe(204);
    expect((await me(accessToken)).status).toBe(401);

    const secondTokenResponse = await exchange(accessKey.plaintext);
    const { accessToken: secondToken } = (await secondTokenResponse.json()) as {
      accessToken: string;
    };
    await repositories.accessKeys.revoke(
      accessKey.record.id,
      now.toISOString(),
    );
    expect((await me(secondToken)).status).toBe(401);
  });

  it("rejects disallowed JWT algorithms, issuer, audience, and expiry", async () => {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const makeToken = (
      header: Record<string, string>,
      claims: Record<string, string | number>,
    ): string => {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const content = `${encode(header)}.${encode(claims)}`;
      const signature = createHmac("sha256", signingKey)
        .update(content)
        .digest("base64url");
      return `${content}.${signature}`;
    };
    const claims = {
      sub: "user-1",
      jti: randomUUID(),
      iss: issuer,
      aud: audience,
      iat: nowSeconds,
      exp: nowSeconds + 1800,
    };
    const validHeader = { alg: "HS256", typ: "JWT" };
    const forgedTokens = [
      makeToken({ alg: "HS512", typ: "JWT" }, claims),
      makeToken(validHeader, { ...claims, iss: "another-issuer" }),
      makeToken(validHeader, { ...claims, aud: "another-audience" }),
      makeToken(validHeader, {
        ...claims,
        iat: nowSeconds - 1800,
        exp: nowSeconds,
      }),
    ];
    for (const token of forgedTokens) {
      expect((await me(token)).status).toBe(401);
    }
  });

  it("invalidates sessions after key expiry and user disablement", async () => {
    const expiring = createUserAccessKey(
      "user-1",
      "2026-10-28T00:00:30.000Z",
      now,
    );
    await repositories.accessKeys.insert(expiring.record);
    const tokenResponse = await exchange(expiring.plaintext);
    const { accessToken } = (await tokenResponse.json()) as {
      accessToken: string;
    };
    now = new Date("2026-10-28T00:00:31.000Z");
    expect((await me(accessToken)).status).toBe(401);

    now = new Date("2026-10-28T00:01:00.000Z");
    const nextResponse = await exchange(accessKey.plaintext);
    const { accessToken: nextToken } = (await nextResponse.json()) as {
      accessToken: string;
    };
    const user = await repositories.users.findById("user-1");
    if (!user) throw new Error("Test user disappeared");
    await repositories.users.replace({
      ...user,
      disabledAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect((await me(nextToken)).status).toBe(401);
  });

  it("enforces live roles and indistinguishable owner misses", async () => {
    const tokenResponse = await exchange(accessKey.plaintext);
    const { accessToken } = (await tokenResponse.json()) as {
      accessToken: string;
    };

    const sample = syntheticWorkflowFixtures.dataAnalysis.case;
    await repositories.cases.insert(
      CaseSchema.parse({
        ...sample,
        id: "owned-case",
        title: "Owned case",
        ownerId: "user-1",
        isSample: false,
        sourceCaseId: null,
      }),
    );
    await repositories.cases.insert(
      CaseSchema.parse({
        ...sample,
        id: "other-case",
        title: "Other case",
        ownerId: "another-user",
        isSample: false,
        sourceCaseId: null,
      }),
    );

    const guardApp = express();
    const authenticateTestRequest = (
      request: Request,
      response: express.Response,
      next: express.NextFunction,
    ): void => {
      const token = bearerToken(request);
      if (!token) {
        response.status(401).end();
        return;
      }
      void service
        .authenticate(token)
        .then((context) => {
          (request as RequestWithAuth).authContext = context;
          next();
        })
        .catch(() => response.status(401).end());
    };
    guardApp.get(
      "/admin",
      authenticateTestRequest,
      requireAdmin,
      (_request, response) => response.status(200).end(),
    );
    guardApp.get(
      "/cases/:caseId",
      authenticateTestRequest,
      requireCaseOwner(repositories.cases),
      (_request, response) => response.status(200).end(),
    );
    const guardServer = await listen(guardApp);
    try {
      const headers = { authorization: `Bearer ${accessToken}` };
      expect(
        (await fetch(`${guardServer.baseUrl}/admin`, { headers })).status,
      ).toBe(403);
      const owned = await fetch(`${guardServer.baseUrl}/cases/owned-case`, {
        headers,
      });
      const other = await fetch(`${guardServer.baseUrl}/cases/other-case`, {
        headers,
      });
      const missing = await fetch(`${guardServer.baseUrl}/cases/missing-case`, {
        headers,
      });
      expect(owned.status).toBe(200);
      expect(other.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await other.json()).toEqual(await missing.json());

      const user = await repositories.users.findById("user-1");
      if (!user) throw new Error("Test user disappeared");
      await repositories.users.replace({ ...user, role: "admin" });
      expect(
        (await fetch(`${guardServer.baseUrl}/admin`, { headers })).status,
      ).toBe(200);
    } finally {
      await guardServer.close();
    }
  });

  it("rejects unconfigured origins", async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: "https://attacker.example.test" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const allowed = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: webOrigin },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(webOrigin);
  });

  it("applies the shared authenticated-user request limit", async () => {
    const limited = createApiApp({
      repositories,
      configuration: {
        jwtSigningKey: signingKey,
        jwtIssuer: issuer,
        jwtAudience: audience,
        jwtTtlSeconds: 1800,
        authRateLimitPerMinute: 10,
        apiRateLimitPerMinute: 1,
        webOrigin,
        trustProxyHops: 0,
        sessionRecheckSeconds: 30,
      },
      now: () => now,
    });
    await close();
    const server = await listen(limited.app);
    close = server.close;
    baseUrl = server.baseUrl;

    const result = await limited.service.exchangeAccessKey(accessKey.plaintext);
    if (!result) throw new Error("Test access key was not accepted");
    expect((await me(result.accessToken)).status).toBe(200);
    expect((await me(result.accessToken)).status).toBe(429);
  });
});
