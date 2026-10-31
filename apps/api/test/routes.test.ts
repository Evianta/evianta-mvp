import { syntheticWorkflowFixtures } from "@evianta/core";
import { InMemoryDocumentStore, createInMemoryStore } from "@evianta/store";
import {
  BUSINESS_DATA_ANALYST_ROLE,
  createBusinessDataAnalystAgent,
  seedAgentDirectoryAsync,
} from "@evianta/agents";
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
import { FetchWebApiClient } from "../../web/src/api/client.js";
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

  it("exposes configured intake limits only to authenticated owners", async () => {
    expect((await fetch(`${baseUrl}/intake/configuration`)).status).toBe(401);
    const response = await fetch(`${baseUrl}/intake/configuration`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflows: ["data-analysis", "tax-notice"],
      ...services.uploads,
    });
  });

  it("allows tax notice cases to be created", async () => {
    const response = await fetch(`${baseUrl}/cases`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Synthetic tax notice",
        description: "Review and reconcile a notice",
        useCase: "tax-notice",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      case: { useCase: "tax-notice", title: "Synthetic tax notice" },
    });
  });

  it("blocks unavailable workflows from creation, upload and run admission", async () => {
    const useCase = "msme-payment" as const;
    const response = await fetch(`${baseUrl}/cases`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ title: "Not available", useCase }),
    });
    expect(response.status).toBe(409);
    expect(await repositories.cases.listOwned(user.id)).toEqual([]);
    const record = {
      ...syntheticWorkflowFixtures.dataAnalysis.case,
      id: `disabled-${useCase}`,
      ownerId: user.id,
      isSample: false,
      synthetic: false,
      useCase,
    };
    await repositories.cases.insert(record);
    for (const [path, body] of [
      ["/runs", { caseId: record.id }],
      [`/cases/${record.id}/run`, {}],
      [`/cases/${record.id}/retry`, { priorRunId: "absent" }],
      [`/cases/${record.id}/documents`, {}],
    ] as const) {
      const blocked = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        error: { message: expect.stringContaining("coming next") },
      });
    }
    expect(
      await repositories.documents.listOwned({
        ownerId: user.id,
        caseId: record.id,
      }),
    ).toEqual([]);
    expect(await repositories.runs.listForCase(record.id, user.id)).toEqual([]);
  });

  it.each([undefined, null, "sample-sales-quarter"])(
    "accepts the web client's case-creation request with source %s",
    async (sourceCaseId) => {
      const client = new FetchWebApiClient({
        baseUrl,
        getToken: () => token,
        onUnauthorized: () => {
          throw new Error("The test session was unexpectedly rejected");
        },
      });
      const created = await client.createCase({
        title: "Sales verification",
        description: "Analyze the uploaded dataset",
        useCase: "data-analysis",
        sourceCaseId,
      });
      expect(created).toMatchObject({
        ownerId: user.id,
        useCase: "data-analysis",
        sourceCaseId: sourceCaseId ?? null,
        isSample: false,
        synthetic: false,
      });
      expect(
        await repositories.documents.listOwned({
          ownerId: user.id,
          caseId: created.id,
        }),
      ).toEqual([]);
    },
  );

  it.each(["private-case", "unknown-sample"])(
    "rejects a non-public setup source %s",
    async (sourceCaseId) => {
      const response = await fetch(`${baseUrl}/cases`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          title: "Sales verification",
          useCase: "data-analysis",
          sourceCaseId,
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation-failed" },
      });
      expect(await repositories.cases.listOwned(user.id)).toEqual([]);
    },
  );

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
    ).toHaveLength(4);

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

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ caseId: created.case.id, input: {} }),
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
    const latestRun = await fetch(
      `${baseUrl}/cases/${created.case.id}/runs/latest`,
      { headers: authHeaders() },
    );
    expect(latestRun.status).toBe(200);
    expect(await latestRun.json()).toMatchObject({ run: { id: run.id } });

    await worker.runOnceAsync();
    const listAfter = repositories.events.listAfter.bind(repositories.events);
    let eventReads = 0;
    repositories.events.listAfter = async (...args) => {
      eventReads += 1;
      if (eventReads <= 2) return [];
      return listAfter(...args);
    };
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
    repositories.events.listAfter = listAfter;

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

    const invalidBatch = new FormData();
    invalidBatch.append(
      "files",
      new Blob(["Valid first file"], { type: "text/plain" }),
      "valid.txt",
    );
    invalidBatch.append(
      "files",
      new Blob([Uint8Array.of(0, 1, 2)], { type: "image/png" }),
      "unsupported.png",
    );
    const rejectedBatch = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      {
        method: "POST",
        headers: authHeaders(),
        body: invalidBatch,
      },
    );
    expect(rejectedBatch.status).toBe(400);
    expect(
      await repositories.documents.listOwned({
        ownerId: user.id,
        caseId: created.case.id,
      }),
    ).toHaveLength(1);

    const tooManyFiles = new FormData();
    for (let index = 0; index < 6; index += 1) {
      tooManyFiles.append(
        "files",
        new Blob(["x"], { type: "text/plain" }),
        `file-${index}.txt`,
      );
    }
    const tooMany = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      {
        method: "POST",
        headers: authHeaders(),
        body: tooManyFiles,
      },
    );
    expect(tooMany.status).toBe(413);

    const malformedMultipart = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "multipart/form-data",
        },
        body: "malformed multipart request",
      },
    );
    expect(malformedMultipart.status).toBe(400);

    const authenticated = await authenticationService.authenticate(token);
    let authenticationChecks = 0;
    const authenticate = authenticationService.authenticate.bind(
      authenticationService,
    );
    let releaseAuthentication: (() => void) | undefined;
    let signalRecheckStarted: (() => void) | undefined;
    const recheckStarted = new Promise<void>((resolve) => {
      signalRecheckStarted = resolve;
    });
    authenticationService.authenticate = async (value) => {
      authenticationChecks += 1;
      if (authenticationChecks === 1) {
        return {
          ...authenticated,
          session: {
            ...authenticated.session,
            expiresAt: new Date(Date.now() + 1_500).toISOString(),
          },
        };
      }
      signalRecheckStarted?.();
      await new Promise<void>((resolve) => {
        releaseAuthentication = resolve;
      });
      return authenticate(value);
    };
    const readStoredObject = services.storage.readStreamAsync.bind(
      services.storage,
    );
    services.storage.readStreamAsync = async (key) => {
      const object = await readStoredObject(key);
      if (!object) return null;
      return {
        ...object,
        body: (async function* () {
          const chunk = Buffer.alloc(1024 * 1024);
          while (true) yield chunk;
        })(),
      };
    };
    const protectedDownload = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents/${document.id}/download`,
      { headers: authHeaders() },
    );
    expect(protectedDownload.status).toBe(200);
    await recheckStarted;
    await new Promise((resolve) => setTimeout(resolve, 750));
    await expect(protectedDownload.arrayBuffer()).rejects.toThrow();
    expect(authenticationChecks).toBe(2);
    releaseAuthentication?.();
  });

  it("runs an uploaded sales dataset and persists its report and chart specs", async () => {
    const analyst = createHarness({
      repositories,
      provider: new ScriptedProvider({
        "business-data-analyst": () => ({
          interpretation:
            "Monthly revenue increased through the quarter, led by product B.",
          insights: [
            {
              title: "Revenue increased by period",
              description:
                "The grouped values show a rising trend across the supplied months.",
              severity: "low",
              assumptions: [],
              openQuestions: [],
            },
          ],
        }),
      }),
      plan: {
        ...planOf([
          { key: "sales-analysis", role: BUSINESS_DATA_ANALYST_ROLE },
        ]),
        title: "Sales data analysis",
        format: "dashboard",
      },
      specialists: [createBusinessDataAnalystAgent()],
      reviewer: false,
    });
    services.orchestrator = analyst.orchestrator;
    worker = analyst.worker;

    const created = await createCase();
    const form = new FormData();
    form.append(
      "files",
      new Blob(
        [
          [
            "month,product,revenue",
            "Jan,A,100",
            "Jan,B,150",
            "Feb,A,120",
            "Feb,B,180",
            "Mar,A,200",
            "Mar,B,250",
          ].join("\n"),
        ],
        { type: "text/csv" },
      ),
      "quarterly-sales.csv",
    );
    const uploaded = await fetch(
      `${baseUrl}/cases/${created.case.id}/documents`,
      { method: "POST", headers: authHeaders(), body: form },
    );
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      documents: [expect.objectContaining({ state: "ready" })],
    });

    const started = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ caseId: created.case.id, input: {} }),
    });
    expect(started.status).toBe(202);
    const { run } = (await started.json()) as { run: { id: string } };
    await worker.runOnceAsync();

    const details = await fetch(`${baseUrl}/cases/${created.case.id}`, {
      headers: authHeaders(),
    });
    const body = (await details.json()) as {
      deliverables: Array<{
        id: string;
        version: number;
        format: string;
        sections: Array<{
          id: string;
          reviewStatus: string;
          content: {
            report: { metrics: { total: number } };
            dashboard: { charts: unknown[] };
          };
          evidenceIds: string[];
        }>;
      }>;
      evidence: Array<{
        location: { rowRange?: { start: number; end: number } };
      }>;
      runs: Array<{ id: string; status: string }>;
    };

    expect(body.runs).toContainEqual(
      expect.objectContaining({ id: run.id, status: "completed" }),
    );
    const deliverable = body.deliverables.find(
      (item) => item.format === "dashboard",
    );
    expect(deliverable?.sections[0]?.content.report.metrics.total).toBe(1000);
    expect(deliverable?.sections[0]?.content.dashboard.charts).toHaveLength(3);
    expect(
      body.evidence.some(
        (item) =>
          item.location.rowRange?.start === 2 &&
          item.location.rowRange.end === 7,
      ),
    ).toBe(true);

    if (!deliverable || !deliverable.sections[0]) {
      throw new Error("The analyst run did not produce a reviewable section.");
    }
    const section = deliverable.sections[0];
    const missingComment = await fetch(
      `${baseUrl}/cases/${created.case.id}/deliverables/${deliverable.id}/sections/${section.id}`,
      {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: deliverable.version,
          reviewStatus: "changes-requested",
        }),
      },
    );
    expect(missingComment.status).toBe(400);

    const review = await fetch(
      `${baseUrl}/cases/${created.case.id}/deliverables/${deliverable.id}/sections/${section.id}`,
      {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: deliverable.version,
          reviewStatus: "accepted",
          reviewerContent: "Reviewer-adjusted summary.",
        }),
      },
    );
    expect(review.status).toBe(200);
    const reviewedDeliverable = (
      (await review.json()) as {
        deliverable: {
          version: number;
          sections: Array<{
            reviewStatus: string;
            reviewerContent: string | null;
            reviewerId: string | null;
          }>;
        };
      }
    ).deliverable;
    expect(reviewedDeliverable.version).toBe(deliverable.version + 1);
    expect(reviewedDeliverable.sections[0]).toMatchObject({
      reviewStatus: "accepted",
      reviewerContent: "Reviewer-adjusted summary.",
      reviewerId: user.id,
    });

    const staleApproval = await fetch(
      `${baseUrl}/cases/${created.case.id}/approve`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deliverableId: deliverable.id,
          deliverableVersion: deliverable.version,
        }),
      },
    );
    expect(staleApproval.status).toBe(409);

    const approvalResponse = await fetch(
      `${baseUrl}/cases/${created.case.id}/approve`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deliverableId: deliverable.id,
          deliverableVersion: reviewedDeliverable.version,
          note: "Reviewed the analyst output.",
        }),
      },
    );
    expect(approvalResponse.status).toBe(201);
    expect(await approvalResponse.json()).toMatchObject({
      approval: {
        caseId: created.case.id,
        deliverableId: deliverable.id,
        deliverableVersion: reviewedDeliverable.version,
        actorId: user.id,
        unresolvedQuestionIds: [],
        note: "Reviewed the analyst output.",
      },
    });
    const duplicateApproval = await fetch(
      `${baseUrl}/cases/${created.case.id}/approve`,
      {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deliverableId: deliverable.id,
          deliverableVersion: reviewedDeliverable.version,
          note: "Reviewed the analyst output.",
        }),
      },
    );
    expect(duplicateApproval.status).toBe(200);

    const nextReview = await fetch(
      `${baseUrl}/cases/${created.case.id}/deliverables/${deliverable.id}/sections/${section.id}`,
      {
        method: "PATCH",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedVersion: reviewedDeliverable.version,
          reviewStatus: "pending",
        }),
      },
    );
    expect(nextReview.status).toBe(200);
    const updatedDetails = await fetch(`${baseUrl}/cases/${created.case.id}`, {
      headers: authHeaders(),
    });
    expect(
      ((await updatedDetails.json()) as { approvals: unknown[] }).approvals,
    ).toEqual([]);
  });

  it("requests case deletion without overwriting concurrent usage updates", async () => {
    const created = await createCase();
    const findOwnedById = repositories.cases.findOwnedById.bind(
      repositories.cases,
    );
    let concurrentUpdate = false;
    repositories.cases.findOwnedById = async (id, ownerId) => {
      const current = await findOwnedById(id, ownerId);
      if (current && !concurrentUpdate) {
        concurrentUpdate = true;
        await repositories.cases.replaceOwned(
          {
            ...current,
            usage: {
              ...current.usage,
              reservedUsd: current.usage.reservedUsd + 1,
            },
          },
          ownerId,
        );
      }
      return current;
    };

    const response = await fetch(`${baseUrl}/cases/${created.case.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      caseId: created.case.id,
      status: "deletion-pending",
    });
    expect(
      await repositories.cases.findOwnedById(created.case.id, user.id),
    ).toMatchObject({
      status: "archived",
      usage: { reservedUsd: 1 },
    });
  });

  it("ends an event stream when its session is revoked during an event read", async () => {
    const created = await createCase();
    const runResponse = await fetch(`${baseUrl}/cases/${created.case.id}/run`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(runResponse.status).toBe(202);
    const { run } = (await runResponse.json()) as { run: { id: string } };

    const listAfter = repositories.events.listAfter.bind(repositories.events);
    let eventReads = 0;
    let releaseRead!: () => void;
    const blockedRead = new Promise<Awaited<ReturnType<typeof listAfter>>>(
      (resolve) => {
        releaseRead = () => resolve([]);
      },
    );
    repositories.events.listAfter = (...args) => {
      eventReads += 1;
      return eventReads === 2 ? blockedRead : listAfter(...args);
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(
        `${baseUrl}/cases/${created.case.id}/stream?runId=${run.id}`,
        { headers: authHeaders() },
      );
      expect(response.status).toBe(200);
      if (!response.body) throw new Error("The event stream has no body");
      reader = response.body.getReader();
      const session = (await authenticationService.authenticate(token)).session;
      await authenticationService.logout(session.id);

      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      expect(result).not.toBeNull();
      expect(new TextDecoder().decode(result?.value)).toContain(
        "event: reauthenticate",
      );
    } finally {
      releaseRead();
      repositories.events.listAfter = listAfter;
      await reader?.cancel().catch(() => undefined);
    }
  });

  it("restricts administrator usage reports to administrator sessions", async () => {
    const response = await fetch(`${baseUrl}/admin/usage/summary`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(403);
  });
});
