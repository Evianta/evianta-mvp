import { syntheticWorkflowFixtures } from "@evianta/core";
import { InMemoryDocumentStore, createInMemoryStore } from "@evianta/store";
import { seedAgentDirectoryAsync } from "@evianta/agents";
import { createDocumentIngestion } from "@evianta/ingestion";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiApp } from "../src/app.js";
import {
  createUserAccessKey,
  type AuthenticationService,
} from "../src/auth.js";
import { registerCaseApiRoutes, type CaseApiServices } from "../src/routes.js";
import {
  createHarness,
  planOf,
  ScriptedProvider,
  seedAsync,
} from "../../../packages/agents/test/harness.js";

const configuration = {
  jwtSigningKey: "a-test-only-signing-key-that-is-at-least-32-bytes",
  jwtIssuer: "evianta-test",
  jwtAudience: "evianta-api-test",
  jwtTtlSeconds: 1800 as const,
  authRateLimitPerMinute: 20,
  apiRateLimitPerMinute: 100,
  webOrigin: "https://app.example.test",
  trustProxyHops: 0,
  sessionRecheckSeconds: 1,
};

const user = {
  id: "route-user",
  email: "route-user@example.test",
  displayName: "Route User",
  role: "user" as const,
  disabledAt: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

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
  if (!address) throw new Error("The test API did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("case API routes", () => {
  let repositories: ReturnType<typeof createInMemoryStore>["repositories"];
  let worker: ReturnType<typeof createHarness>["worker"];
  let services: CaseApiServices;
  let authenticationService: AuthenticationService;
  let baseUrl: string;
  let closeServer: (() => Promise<void>) | undefined;
  let token: string;

  beforeEach(async () => {
    const store = createInMemoryStore();
    repositories = store.repositories;
    await repositories.users.insert(user);
    await seedAsync(repositories, `route-seed-${Math.random()}`);
    await seedAgentDirectoryAsync(repositories.agentProfiles);
    const storage = new InMemoryDocumentStore();
    const ingestion = createDocumentIngestion({
      documents: repositories.documents,
      extractions: repositories.extractions,
      storage,
      ocr: null,
      options: { limits: { maxBytes: 1024, maxPages: 20 } },
    });
    const harness = createHarness({
      repositories,
      provider: new ScriptedProvider({
        analysis: () => ({
          summary: "Analysis completed",
          findings: [],
          inputRequired: null,
        }),
      }),
      plan: planOf([{ key: "analysis", role: "generic-analyst" }]),
      reviewer: false,
    });
    worker = harness.worker;
    services = {
      repositories,
      storage,
      orchestrator: harness.orchestrator,
      usageAdmin: repositories.usageAdmin,
      uploads: {
        uploadMaxBytes: 1024,
        uploadMaxFiles: 5,
        documentMaxPages: 20,
      },
      ingestion,
    };
    const key = createUserAccessKey(user.id);
    await repositories.accessKeys.insert(key.record);
    const api = createApiApp({
      repositories,
      configuration,
      registerRoutes: (context) => registerCaseApiRoutes(context, services),
    });
    authenticationService = api.service;
    const exchanged = await api.service.exchangeAccessKey(key.plaintext);
    if (!exchanged) throw new Error("Test access key was not accepted");
    token = exchanged.accessToken;
    const server = await listen(api.app);
    baseUrl = server.baseUrl;
    closeServer = server.close;
  });

  afterEach(async () => {
    await closeServer?.();
  });

  function authHeaders(accessToken = token): HeadersInit {
    return { authorization: `Bearer ${accessToken}` };
  }

  async function createCase() {
    const response = await fetch(`${baseUrl}/cases`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Test engagement",
        description: "Synthetic API coverage",
        useCase: "data-analysis",
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      case: { id: string; title: string };
    };
  }

  it("serves public synthetic samples and authenticated case/profile routes", async () => {
    const publicSamples = await fetch(`${baseUrl}/samples`);
    expect(publicSamples.status).toBe(200);
    expect(
      ((await publicSamples.json()) as { samples: unknown[] }).samples,
    ).toHaveLength(3);

    const agents = await fetch(`${baseUrl}/agents`, {
      headers: authHeaders(),
    });
    expect(agents.status).toBe(200);
    expect(
      ((await agents.json()) as { agents: unknown[] }).agents,
    ).toHaveLength(3);

    const created = await createCase();
    const listed = await fetch(`${baseUrl}/cases`, {
      headers: authHeaders(),
    });
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { cases: Array<{ id: string }> }).cases,
    ).toContainEqual(expect.objectContaining({ id: created.case.id }));

    const copied = await fetch(
      `${baseUrl}/cases/${syntheticWorkflowFixtures.dataAnalysis.case.id}/copy`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(copied.status).toBe(201);
    const copyBody = (await copied.json()) as {
      case: { id: string; sourceCaseId: string };
      documents: Array<{ name: string; state: string }>;
    };
    expect(copyBody.case.sourceCaseId).toBe(
      syntheticWorkflowFixtures.dataAnalysis.case.id,
    );
    expect(copyBody.documents).toHaveLength(1);
    expect(copyBody.documents[0]?.state).toBe("ready");

    const sampleDownload = await fetch(
      `${baseUrl}/samples/${syntheticWorkflowFixtures.dataAnalysis.case.id}/documents/sales-transactions/download`,
    );
    expect(sampleDownload.status).toBe(200);
    expect(sampleDownload.headers.get("content-type")).toContain(
      "application/json",
    );

    const sampleMutation = await fetch(
      `${baseUrl}/cases/${syntheticWorkflowFixtures.dataAnalysis.case.id}/run`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    expect(sampleMutation.status).toBe(409);
    expect(await sampleMutation.json()).toMatchObject({
      reason: "sample-read-only",
      copyUrl: expect.stringContaining("/copy"),
    });
  });

  it("bounds uploads, protects child downloads, and replays persisted run events", async () => {
    const created = await createCase();
    const form = new FormData();
    form.append(
      "files",
      new Blob(["Revenue: 42"], { type: "text/plain" }),
      "notes.txt",
    );
    const uploaded = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      {
        method: "POST",
        headers: authHeaders(),
        body: form,
      },
    );
    expect(uploaded.status).toBe(201);
    const uploadBody = (await uploaded.json()) as {
      documents: Array<{ id: string; state: string; name: string }>;
    };
    expect(uploadBody.documents[0]).toMatchObject({
      state: "ready",
      name: "notes.txt",
    });
    const document = uploadBody.documents[0];
    if (!document) throw new Error("Uploaded document was not returned");

    const details = await fetch(`${baseUrl}/cases/${created.case.id}`, {
      headers: authHeaders(),
    });
    expect(details.status).toBe(200);
    const detailBody = (await details.json()) as {
      documents: Array<Record<string, unknown>>;
    };
    expect(detailBody.documents[0]).not.toHaveProperty("objectKey");
    expect(detailBody.documents[0]).not.toHaveProperty("contentHash");

    const download = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents/${document.id}/download`,
      { headers: authHeaders() },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("Revenue: 42");

    const secondUser = {
      ...user,
      id: "route-user-2",
      email: "route-user-2@example.test",
    };
    await repositories.users.insert(secondUser);
    const secondKey = createUserAccessKey(secondUser.id);
    await repositories.accessKeys.insert(secondKey.record);
    const secondSession = await authenticationService.exchangeAccessKey(
      secondKey.plaintext,
    );
    if (!secondSession) throw new Error("Second test key was not accepted");
    const deniedCase = await fetch(`${baseUrl}/cases/${created.case.id}`, {
      headers: authHeaders(secondSession.accessToken),
    });
    const deniedDocument = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents/${document.id}/download`,
      { headers: authHeaders(secondSession.accessToken) },
    );
    expect(deniedCase.status).toBe(404);
    expect(deniedDocument.status).toBe(404);

    const runResponse = await fetch(`${baseUrl}/cases/${created.case.id}/run`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const { run } = (await runResponse.json()) as {
      run: { id: string; status: string };
    };
    const deniedStream = await fetch(
      `${baseUrl}/cases/${created.case.id}/stream?runId=${run.id}`,
      { headers: authHeaders(secondSession.accessToken) },
    );
    expect(deniedStream.status).toBe(404);
    expect(run.status).toBe("queued");
    expect(
      await repositories.runs.findOwnedById(run.id, user.id),
    ).toMatchObject({ status: "queued" });

    await worker.runOnceAsync();
    const stream = await fetch(
      `${baseUrl}/cases/${created.case.id}/stream?runId=${run.id}`,
      { headers: authHeaders() },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const frames = await stream.text();
    expect(frames).toContain("event: run-started");
    expect(frames).toContain("event: run-completed");
    expect(frames).toMatch(/id: \d+/);

    const futureCursor = await fetch(
      `${baseUrl}/cases/${created.case.id}/stream?runId=${run.id}&cursor=999999`,
      { headers: authHeaders() },
    );
    expect(futureCursor.status).toBe(400);

    const oversizedForm = new FormData();
    oversizedForm.append(
      "files",
      new Blob(["x".repeat(2048)], { type: "text/plain" }),
      "too-large.txt",
    );
    const oversized = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      {
        method: "POST",
        headers: authHeaders(),
        body: oversizedForm,
      },
    );
    expect(oversized.status).toBe(413);

    const session = (await authenticationService.authenticate(token)).session;
    let authenticationChecks = 0;
    const authenticate = authenticationService.authenticate.bind(
      authenticationService,
    );
    authenticationService.authenticate = async (value) => {
      authenticationChecks += 1;
      return authenticate(value);
    };
    const readStoredObject = services.storage.readStreamAsync.bind(
      services.storage,
    );
    services.storage.readStreamAsync = async (key) => {
      const object = await readStoredObject(key);
      if (!object) return null;
      await authenticationService.logout(session.id);
      return {
        ...object,
        body: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          yield Buffer.from("revoked now");
        })(),
      };
    };
    const protectedDownload = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents/${document.id}/download`,
      { headers: authHeaders() },
    );
    expect(protectedDownload.status).toBe(200);
    await expect(authenticationService.authenticate(token)).rejects.toThrow();
    expect(authenticationChecks).toBeGreaterThanOrEqual(3);
    expect(await protectedDownload.text()).toBe("");
  });

  it("restricts administrator usage reports to administrator sessions", async () => {
    const response = await fetch(`${baseUrl}/admin/usage/summary`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(403);
  });
});
