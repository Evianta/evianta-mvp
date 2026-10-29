import {
  CaseSchema,
  syntheticWorkflowFixtures,
  type Case,
  type Deliverable,
  type ExtractedDocument,
  type OwnerScope,
  type RunRecord,
  type UsagePrice,
  type UsageRecord,
  type UsageReservationRequest,
} from "@evianta/core";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createInMemoryStore } from "../src/memory.js";
import { MongoStore } from "../src/mongo.js";

const timestamp = "2026-01-15T00:00:00.000Z";
const usageSummary = syntheticWorkflowFixtures.dataAnalysis.case.usage;
const ownerScope: OwnerScope = { ownerId: "owner-1", caseId: "case-1" };

function makeCase(
  id: string,
  ownerId: string,
  overrides: Partial<Case> = {},
): Case {
  return CaseSchema.parse({
    ...syntheticWorkflowFixtures.dataAnalysis.case,
    id,
    title: id,
    ownerId,
    isSample: false,
    synthetic: true,
    sourceCaseId: null,
    ...overrides,
  });
}

function makeRun(id: string, caseId: string, ownerId: string): RunRecord {
  return {
    id,
    caseId,
    ownerId,
    threadId: `thread-${id}`,
    planVersion: 1,
    status: "running",
    priorRunId: null,
    leaseId: null,
    fencingToken: 0,
    leaseExpiresAt: null,
    cancellationRequested: false,
    inputRequired: false,
    usage: usageSummary,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeDeliverable(id: string, version: number): Deliverable {
  return {
    id,
    caseId: ownerScope.caseId,
    runId: "run-1",
    version,
    format: "report",
    title: "Report",
    summary: "Synthetic result",
    sections: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeUsage(id: string, attemptId = `attempt-${id}`): UsageRecord {
  return {
    id,
    attemptId,
    provider: "mock",
    model: "mock-spark",
    settings: {},
    units: {
      input: 0,
      output: 0,
      total: 0,
      reasoning: null,
      cacheRead: null,
      cacheWrite: null,
      search: null,
    },
    costUsd: 0,
    costStatus: "estimated",
    recordedAt: timestamp,
  };
}

function makeUsagePrice(): UsagePrice {
  return {
    id: "price-v1",
    provider: "muse",
    model: "spark",
    settingsKey: "settings-v1",
    settings: { maxOutputTokens: 100 },
    currency: "USD",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cacheReadUsdPerMillion: 1,
    cacheWriteUsdPerMillion: 1,
    searchUsdPerRequest: null,
    version: 1,
    source: "test",
    effectiveAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeReservationRequest(
  attemptId: string,
  amountUsd: number,
): UsageReservationRequest {
  const price = makeUsagePrice();
  return {
    attemptId,
    idempotencyKey: attemptId,
    ownerId: "owner-1",
    caseId: "case-1",
    runId: "run-1",
    leaseId: "usage-lease",
    fencingToken: 1,
    taskId: null,
    provider: "muse",
    model: "spark",
    settings: price.settings,
    price,
    inputAllowanceTokens: Math.max(1, Math.floor(amountUsd * 1_000_000)),
    outputAllowanceTokens: 1,
    searchRequested: false,
    userSpendLimitUsd: 1,
    globalSpendLimitUsd: 1,
    periodSeconds: 86_400,
    at: timestamp,
    expiresAt: "2027-01-15T00:15:00.000Z",
  };
}

interface Harness {
  store: MongoStore;
  client: MongoClient;
  dbName: string;
}

async function createMongoHarness(pageSize = 50): Promise<Harness> {
  const uri = mongoReplSet!.getUri(
    `evianta_test_${randomUUID().replaceAll("-", "")}`,
  );
  const client = new MongoClient(uri);
  await client.connect();
  const dbName = new URL(uri).pathname.slice(1);
  const store = new MongoStore({ client, db: client.db(dbName), pageSize });
  await store.initialize();
  return { store, client, dbName };
}

let mongoReplSet: MongoMemoryReplSet | undefined;

function repositoryContract(
  name: string,
  setup: () => Promise<{
    repositories: ReturnType<typeof createInMemoryStore>["repositories"];
    close: () => Promise<void>;
  }>,
): void {
  describe(name, () => {
    let repositories: Awaited<ReturnType<typeof setup>>["repositories"];
    let closeStore: () => Promise<void>;

    beforeEach(async () => {
      const harness = await setup();
      repositories = harness.repositories;
      closeStore = harness.close;
    });

    afterEach(async () => {
      await closeStore();
    });

    it("validates case persistence and isolates owner-scoped records", async () => {
      const cases = repositories.cases;
      await cases.insert(makeCase("case-1", "owner-1"));
      await cases.insert(makeCase("case-2", "owner-2"));

      expect(await cases.findOwnedById("case-1", "owner-1")).toMatchObject({
        id: "case-1",
        ownerId: "owner-1",
      });
      expect(await cases.findOwnedById("case-2", "owner-1")).toBeNull();
      expect(await cases.listOwned("owner-1")).toHaveLength(1);
      expect(
        await cases.replaceOwned(makeCase("case-2", "owner-1"), "owner-1"),
      ).toBe(false);
    });

    it("compares session expiry timestamps as instants", async () => {
      await repositories.sessions.insert({
        id: "session-expired",
        userId: "user-1",
        accessKeyId: "key-1",
        issuedAt: timestamp,
        expiresAt: "2026-01-15T01:00:00+02:00",
        revokedAt: null,
        createdAt: timestamp,
      });
      await repositories.sessions.insert({
        id: "session-valid",
        userId: "user-1",
        accessKeyId: "key-1",
        issuedAt: timestamp,
        expiresAt: "2026-01-15T00:00:00-05:00",
        revokedAt: null,
        createdAt: timestamp,
      });

      expect(
        await repositories.sessions.findActiveById(
          "session-expired",
          timestamp,
        ),
      ).toBeNull();
      expect(
        await repositories.sessions.findActiveById(
          "session-valid",
          "2026-01-15T01:00:00.000Z",
        ),
      ).not.toBeNull();
    });

    it("validates revocation timestamps before modifying records", async () => {
      await repositories.accessKeys.insert({
        id: "access-key-1",
        userId: "user-1",
        keyHash: "hash",
        keyPrefix: "prefix",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: timestamp,
      });
      await repositories.sessions.insert({
        id: "session-1",
        userId: "user-1",
        accessKeyId: "access-key-1",
        issuedAt: timestamp,
        expiresAt: "2026-01-16T00:00:00.000Z",
        revokedAt: null,
        createdAt: timestamp,
      });

      await expect(
        repositories.accessKeys.revoke("access-key-1", "yesterday"),
      ).rejects.toThrow();
      await expect(
        repositories.sessions.revoke("session-1", "yesterday"),
      ).rejects.toThrow();
      expect(
        await repositories.accessKeys.findActiveById("access-key-1"),
      ).not.toBeNull();
      expect(
        await repositories.sessions.findActiveById("session-1", timestamp),
      ).not.toBeNull();
    });

    it("expires access keys and records their last use", async () => {
      await repositories.accessKeys.insert({
        id: "expiring-key",
        userId: "user-1",
        keyHash: "hash",
        keyPrefix: "prefix",
        expiresAt: "2026-01-15T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
        createdAt: timestamp,
      });

      expect(
        await repositories.accessKeys.findActiveById(
          "expiring-key",
          "2026-01-14T23:59:59.999Z",
        ),
      ).not.toBeNull();
      expect(
        await repositories.accessKeys.findActiveById(
          "expiring-key",
          "2026-01-15T00:00:00.000Z",
        ),
      ).toBeNull();

      await repositories.accessKeys.markUsed("expiring-key", timestamp);
      expect(
        await repositories.accessKeys.findActiveById(
          "expiring-key",
          "2026-01-14T23:00:00.000Z",
        ),
      ).toMatchObject({ lastUsedAt: timestamp });
    });

    it("atomically counts rate-limit requests in a fixed window", async () => {
      const request = {
        key: "hashed-source",
        limit: 3,
        windowSeconds: 60,
        at: timestamp,
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          repositories.rateLimits.consume(request),
        ),
      );
      const counts = results
        .map((result) => result.count)
        .sort((a, b) => a - b);
      expect(results.filter((result) => result.allowed)).toHaveLength(3);
      expect(results.filter((result) => !result.allowed)).toHaveLength(2);
      expect(counts).toEqual([1, 2, 3, 4, 5]);
      expect(
        results.every(
          (result) => result.resetAt === "2026-01-15T00:01:00.000Z",
        ),
      ).toBe(true);
    });

    it("upserts agent profiles by role even when the profile ID changes", async () => {
      const profile = {
        id: "profile-1",
        role: "analyst",
        displayName: "Analyst",
        specialty: "analysis",
        summary: "First version",
        capabilities: [],
        tools: [],
        procedures: [],
        outputFormats: [],
        limitations: [],
        modelTier: "cheap" as const,
        enabled: true,
      };
      await repositories.agentProfiles.upsert(profile);
      await repositories.agentProfiles.upsert({
        ...profile,
        id: "profile-2",
        summary: "Updated version",
      });

      expect(await repositories.agentProfiles.findByRole("analyst")).toEqual({
        ...profile,
        id: "profile-2",
        summary: "Updated version",
      });
      expect(await repositories.agentProfiles.listEnabled()).toHaveLength(1);
    });

    it("stores only one active run for the same owner and case tuple", async () => {
      await repositories.cases.insert(makeCase("c", "a:b"));
      await repositories.cases.insert(makeCase("b:c", "a"));
      await repositories.runs.insert(makeRun("run-1", "c", "a:b"));
      await repositories.runs.insert(makeRun("run-2", "b:c", "a"));

      expect(
        await repositories.runs.findOwnedById("run-1", "a:b"),
      ).not.toBeNull();
      expect(
        await repositories.runs.findOwnedById("run-2", "a"),
      ).not.toBeNull();
    });

    it("preserves synthetic sample visibility without allowing owner edits", async () => {
      const sample = syntheticWorkflowFixtures.dataAnalysis.case;
      await repositories.cases.insert(sample);

      expect(await repositories.cases.findPublicSampleById(sample.id)).toEqual(
        sample,
      );
      expect(
        await repositories.cases.findOwnedById(sample.id, "owner-1"),
      ).toBeNull();
      expect(await repositories.cases.replaceOwned(sample, "owner-1")).toBe(
        false,
      );
    });

    it("rejects malformed records and duplicate user emails", async () => {
      const invalid = { ...makeCase("invalid-case", "owner-1"), title: "" };
      await expect(repositories.cases.insert(invalid)).rejects.toThrow();

      const user = {
        id: "user-1",
        email: "Example@evianta.test",
        displayName: "Example",
        role: "user" as const,
        disabledAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await repositories.users.insert(user);
      expect(
        await repositories.users.findByEmail(" example@evianta.test "),
      ).toEqual(user);
      await expect(
        repositories.users.insert({
          ...user,
          id: "user-2",
          email: user.email.toLowerCase(),
        }),
      ).rejects.toMatchObject({ code: "duplicate-record" });
    });

    it("isolates documents and strips private metadata from DTOs", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.cases.insert(makeCase("case-2", "owner-2"));
      const documents = repositories.documents;
      const record = {
        id: "document-1",
        caseId: "case-1",
        name: "source.csv",
        mimeType: "text/csv",
        sizeBytes: 16,
        state: "ready" as const,
        uploadedAt: timestamp,
        processedAt: timestamp,
        objectKey: "opaque-object-key",
        contentHash: "sha256-value",
      };

      await documents.insert(record, ownerScope);
      expect(await documents.findOwned("document-1", ownerScope)).toEqual(
        record,
      );
      expect(await documents.listOwned(ownerScope)).toEqual([
        {
          id: "document-1",
          caseId: "case-1",
          name: "source.csv",
          mimeType: "text/csv",
          sizeBytes: 16,
          state: "ready",
          uploadedAt: timestamp,
          processedAt: timestamp,
        },
      ]);
      expect(
        await documents.findOwned("document-1", {
          ownerId: "owner-2",
          caseId: "case-2",
        }),
      ).toBeNull();
    });

    it("finds cached extractions for encoded document IDs", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      const document = {
        id: "document:1",
        caseId: "case-1",
        name: "source.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        state: "ready" as const,
        uploadedAt: timestamp,
        processedAt: null,
        objectKey: "object-key",
        contentHash: "content-hash",
      };
      await repositories.documents.insert(document, ownerScope);
      const extraction: ExtractedDocument = {
        documentId: document.id,
        kind: "text",
        method: "parse",
        confidence: 1,
        pages: [],
        tables: [],
        warnings: [],
        cacheIdentity: {
          contentHash: "content-hash",
          extractorVersion: "1",
          modelVersion: null,
        },
      };
      await repositories.extractions.saveForDocument(extraction, ownerScope);

      expect(
        await repositories.extractions.findForDocument(document.id, ownerScope),
      ).toEqual(extraction);
    });

    it("returns the most recently saved extraction when saves share a millisecond", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      const document = {
        id: "document-revision",
        caseId: "case-1",
        name: "source.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        state: "ready" as const,
        uploadedAt: timestamp,
        processedAt: null,
        objectKey: "object-key",
        contentHash: "content-hash",
      };
      await repositories.documents.insert(document, ownerScope);
      const extraction: ExtractedDocument = {
        documentId: document.id,
        kind: "text",
        method: "parse",
        confidence: 1,
        pages: [],
        tables: [],
        warnings: [],
        cacheIdentity: {
          contentHash: "content-hash",
          extractorVersion: "1",
          modelVersion: null,
        },
      };
      await repositories.extractions.saveForDocument(extraction, ownerScope);
      await repositories.extractions.saveForDocument(
        { ...extraction, method: "ocr" },
        ownerScope,
      );

      expect(
        await repositories.extractions.findForDocument(document.id, ownerScope),
      ).toMatchObject({ method: "ocr" });
    });

    it("enforces case ownership for runs, tasks, findings and usage", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.cases.insert(makeCase("case-2", "owner-2"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-2", "case-2", "owner-2"));

      await expect(
        repositories.tasks.insert(
          {
            id: "task-1",
            caseId: "case-2",
            runId: "run-2",
            role: "analyst",
            dependencyIds: [],
            status: "pending",
            attemptCount: 0,
            lastError: null,
            usage: usageSummary,
          },
          ownerScope,
        ),
      ).rejects.toMatchObject({ code: "case-not-owned" });
      await repositories.usage.insert(
        makeUsage("usage-1"),
        "run-1",
        ownerScope,
      );
      expect(
        await repositories.usage.listForRun("run-1", ownerScope),
      ).toHaveLength(1);
      expect(
        await repositories.usage.listForRun("run-2", ownerScope),
      ).toHaveLength(0);
    });

    it("validates the run association when replacing a deliverable", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.cases.insert(makeCase("case-2", "owner-2"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-2", "case-2", "owner-2"));
      const deliverable = makeDeliverable("deliverable-1", 1);
      await repositories.deliverables.insert(deliverable, ownerScope);

      await expect(
        repositories.deliverables.replaceOwned(
          { ...deliverable, runId: "run-2" },
          ownerScope,
        ),
      ).rejects.toMatchObject({ code: "run-not-owned" });
      expect(
        await repositories.deliverables.findOwnedById(
          deliverable.id,
          ownerScope,
        ),
      ).toEqual(deliverable);
    });

    it("invalidates approval after a deliverable version changes", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const deliverable = makeDeliverable("deliverable-1", 1);
      await repositories.deliverables.insert(deliverable, ownerScope);
      await repositories.approvals.insert(
        {
          id: "approval-1",
          caseId: ownerScope.caseId,
          deliverableId: deliverable.id,
          deliverableVersion: 1,
          actorId: "owner-1",
          approvedAt: timestamp,
          unresolvedQuestionIds: [],
          note: "",
        },
        ownerScope,
      );
      expect(
        await repositories.approvals.findForDeliverable(
          deliverable.id,
          ownerScope,
        ),
      ).not.toBeNull();

      expect(
        await repositories.deliverables.replaceOwned(
          makeDeliverable(deliverable.id, 2),
          ownerScope,
        ),
      ).toBe(true);
      expect(
        await repositories.approvals.findForDeliverable(
          deliverable.id,
          ownerScope,
        ),
      ).toBeNull();
    });

    it("rejects out-of-order events and preserves monotonic visibility", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const event = (id: string, sequence: number) => ({
        id,
        caseId: "case-1",
        runId: "run-1",
        sequence,
        occurredAt: timestamp,
        payload: { type: "run-started" as const, planVersion: 1 },
      });

      await repositories.events.append(event("event-2", 2), ownerScope);
      await expect(
        repositories.events.append(event("event-1", 1), ownerScope),
      ).rejects.toMatchObject({ code: "event-sequence-conflict" });
      expect(
        await repositories.events.listAfter("case-1", 0, ownerScope),
      ).toHaveLength(1);
    });

    it("reports a conflict when reactivating a run beside an active run", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert({
        ...makeRun("run-old", "case-1", "owner-1"),
        status: "completed",
      });
      await repositories.runs.insert(
        makeRun("run-active", "case-1", "owner-1"),
      );

      await expect(
        repositories.runs.updateOwned(
          makeRun("run-old", "case-1", "owner-1"),
          "owner-1",
        ),
      ).rejects.toMatchObject({ code: "duplicate-record" });
    });

    it("rejects events fenced with a stale lease generation", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const stale = {
        id: "event-1",
        caseId: "case-1",
        runId: "run-1",
        sequence: 1,
        occurredAt: timestamp,
        payload: { type: "run-started" as const, planVersion: 1 },
      };

      await expect(
        repositories.events.append(stale, ownerScope, { fencingToken: 5 }),
      ).rejects.toMatchObject({ code: "stale-fencing-token" });
      expect(
        await repositories.events.listAfter("case-1", 0, ownerScope),
      ).toHaveLength(0);
      await repositories.events.append(stale, ownerScope, { fencingToken: 0 });
      expect(
        await repositories.events.listAfter("case-1", 0, ownerScope),
      ).toHaveLength(1);
    });

    it("uses distinct cache identities for null and the string none", async () => {
      const store = createInMemoryStore();
      const { repositories } = store;
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      const document = {
        id: "document-cache",
        caseId: "case-1",
        name: "source.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        state: "ready" as const,
        uploadedAt: timestamp,
        processedAt: null,
        objectKey: "object-key",
        contentHash: "content-hash",
      };
      await repositories.documents.insert(document, ownerScope);
      const base: ExtractedDocument = {
        documentId: document.id,
        kind: "text",
        method: "parse",
        confidence: 1,
        pages: [],
        tables: [],
        warnings: [],
        cacheIdentity: {
          contentHash: "content-hash",
          extractorVersion: "1",
          modelVersion: null,
        },
      };
      await repositories.extractions.saveForDocument(base, ownerScope);
      await repositories.extractions.saveForDocument(
        {
          ...base,
          cacheIdentity: { ...base.cacheIdentity, modelVersion: "none" },
        },
        ownerScope,
      );

      expect(
        await repositories.extractions.findForDocument(document.id, ownerScope),
      ).toMatchObject({ cacheIdentity: { modelVersion: "none" } });
    });

    it("paginates cases by instant time, not timestamp string ordering", async () => {
      const store = createInMemoryStore({ pageSize: 1 });
      await store.repositories.cases.insert(
        makeCase("B", "owner-1", { createdAt: "2026-01-15T01:00:00+02:00" }),
      );
      await store.repositories.cases.insert(
        makeCase("a", "owner-1", { createdAt: "2026-01-14T23:00:00Z" }),
      );
      await store.repositories.cases.insert(
        makeCase("C", "owner-1", { createdAt: "2026-01-15T00:00:00-05:00" }),
      );

      const pageIds: string[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 3; index += 1) {
        const page = await store.repositories.cases.listOwned(
          "owner-1",
          cursor,
        );
        pageIds.push(...page.map((record) => record.id));
        cursor = page[0]?.id;
      }

      expect(pageIds).toEqual(["C", "a", "B"]);
    });

    it("keeps persisted usage scope when the caller mutates its object", async () => {
      const store = createInMemoryStore();
      const repositories = store.repositories;
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const scope = { ...ownerScope };
      await repositories.usage.insert(makeUsage("usage-1"), "run-1", scope);

      scope.caseId = "case-2";
      scope.ownerId = "owner-2";

      expect(
        await repositories.usage.listForRun("run-1", ownerScope),
      ).toHaveLength(1);
    });

    it("reserves spend before dispatch and preserves unknown exposure", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      const currentPrice = makeUsagePrice();
      await repositories.usagePrices.insert(currentPrice);
      await expect(
        repositories.usagePrices.insert({
          ...currentPrice,
          model: "different-model",
          version: 2,
        }),
      ).rejects.toMatchObject({ code: "duplicate-price" });
      await repositories.usagePrices.insert({
        ...currentPrice,
        id: "price-v2",
        version: 2,
        effectiveAt: "2026-02-01T00:00:00.000Z",
      });
      expect(
        await repositories.usagePrices.findActive(
          "muse",
          "spark",
          "settings-v1",
          timestamp,
        ),
      ).toMatchObject({ id: "price-v1", version: 1 });
      expect(
        await repositories.usagePrices.findActive(
          "muse",
          "spark",
          "settings-v1",
          "2026-02-02T00:00:00.000Z",
        ),
      ).toMatchObject({ id: "price-v2", version: 2 });

      const request = makeReservationRequest("attempt-1", 0.6);
      const reservation = await repositories.usageAdmission.reserve(request);
      const admittedSummary = await repositories.usageAdmin.query({
        userId: "admin-1",
        role: "admin",
      });
      expect(admittedSummary.totals.unknownExposureUsd).toBeCloseTo(
        reservation.reservedUsd,
      );
      await expect(
        repositories.usageAdmission.reserve(request),
      ).rejects.toMatchObject({ code: "usage-attempt-exists" });
      await expect(
        repositories.usageAdmission.reserve(
          makeReservationRequest("attempt-2", 0.5),
        ),
      ).rejects.toMatchObject({ code: "spend-limit-exceeded" });

      await repositories.usageAdmission.settle({
        reservation,
        outcome: "unknown",
        units: {
          input: null,
          output: null,
          total: null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
          search: null,
        },
        errorCode: "provider-timeout",
        at: "2026-01-15T00:01:00.000Z",
      });
      await expect(
        repositories.usageAdmission.release(reservation.id, "failed"),
      ).rejects.toMatchObject({ code: "unknown-usage-exposure" });
      await expect(
        repositories.usageAdmission.reserve(
          makeReservationRequest("attempt-3", 0.5),
        ),
      ).rejects.toMatchObject({ code: "spend-limit-exceeded" });

      await expect(
        repositories.usageAdmin.query({ userId: "user-1", role: "user" }),
      ).rejects.toMatchObject({ code: "admin-required" });
      const summary = await repositories.usageAdmin.query({
        userId: "admin-1",
        role: "admin",
      });
      expect(summary.totals).toMatchObject({
        attempts: 1,
        knownChargesUsd: 0,
      });
      expect(summary.totals.unknownExposureUsd).toBeCloseTo(0.600002);
      expect(summary.totals.reservedUsd).toBeCloseTo(0.600002);
      expect(summary.entries[0]).toMatchObject({
        sourceCaseId: null,
        useCase: "data-analysis",
        reservationStatus: "reserved",
        outcome: "unknown",
      });
      expect(
        await repositories.usage.listForRun("run-1", ownerScope),
      ).toMatchObject([
        {
          attemptId: "attempt-1",
          costStatus: "unknown",
          costUsd: null,
        },
      ]);
    });

    it("settles verified usage after an unknown-cost reservation", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });
      await repositories.usagePrices.insert(makeUsagePrice());
      const reservation = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-late-usage", 0.6),
      );
      await repositories.usageAdmission.settle({
        reservation,
        outcome: "unknown",
        units: {
          input: null,
          output: null,
          total: null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
          search: null,
        },
        errorCode: "provider-timeout",
        at: "2026-01-15T00:01:00.000Z",
      });

      await repositories.usageAdmission.settle({
        reservation,
        outcome: "success",
        units: {
          input: 100,
          output: 100,
          total: 200,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          search: 0,
        },
        errorCode: null,
        at: "2026-01-15T00:02:00.000Z",
      });

      expect(
        await repositories.usageAdmin.query({
          userId: "admin-1",
          role: "admin",
        }),
      ).toMatchObject({
        totals: { knownChargesUsd: 0.0003, reservedUsd: 0 },
      });
    });

    it("settles known charges and releases unused reservation capacity", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      await repositories.usagePrices.insert(makeUsagePrice());
      const reservation = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-known", 0.8),
      );
      await expect(
        repositories.usageAdmission.settle({
          reservation,
          outcome: "success",
          units: {
            input: 100,
            output: 100,
            total: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            search: 0,
          },
          errorCode: null,
          at: "2026-01-15T00:01:00.000Z",
        }),
      ).rejects.toThrow();
      await repositories.usageAdmission.settle({
        reservation,
        outcome: "success",
        units: {
          input: 100,
          output: 100,
          total: 200,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          search: 0,
        },
        errorCode: null,
        at: "2026-01-15T00:01:00.000Z",
      });
      const followup = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-followup", 0.7),
      );
      expect(followup.status).toBe("reserved");
      await expect(
        repositories.usageAdmission.reserve(
          makeReservationRequest("attempt-over", 0.999),
        ),
      ).rejects.toMatchObject({ code: "spend-limit-exceeded" });

      const summary = await repositories.usageAdmin.query({
        userId: "admin-1",
        role: "admin",
      });
      expect(summary.totals).toMatchObject({
        attempts: 2,
      });
      expect(summary.totals.knownChargesUsd).toBeCloseTo(0.0003);
      expect(summary.totals.reservedUsd).toBeCloseTo(0.700002);
    });

    it("keeps USD budget reservations exact across decimal settlements", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.usagePrices.insert(makeUsagePrice());
      await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      const tenth = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-tenth", 0.1),
      );
      const sevenTenths = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-seven-tenths", 0.7),
      );
      await repositories.usageAdmission.settle({
        reservation: sevenTenths,
        outcome: "success",
        units: {
          input: 100,
          output: 100,
          total: 200,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          search: 0,
        },
        errorCode: null,
        at: "2026-01-15T00:01:00.000Z",
      });
      await repositories.usageAdmission.release(tenth.id, "failed");
      const next = await repositories.usageAdmission.reserve(
        makeReservationRequest("attempt-next", 0.9),
      );
      expect(next.status).toBe("reserved");
    });

    it("scopes run usage ledger queries to the requested case", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.cases.insert(makeCase("case-2", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-2", "case-2", "owner-1"));
      await repositories.usagePrices.insert(makeUsagePrice());
      const lease = await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-2",
        runId: "run-2",
        leaseId: "lease-2",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      await repositories.usageAdmission.reserve({
        ...makeReservationRequest("attempt-case-2", 0.1),
        caseId: "case-2",
        runId: "run-2",
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      });

      expect(await repositories.usage.listForRun("run-2", ownerScope)).toEqual(
        [],
      );
    });

    it("recovers expired admitted attempts as unknown exposure without releasing funds", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.usagePrices.insert(makeUsagePrice());
      await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2027-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      const reservation = await repositories.usageAdmission.reserve({
        ...makeReservationRequest("attempt-expired", 0.1),
        expiresAt: "2026-01-15T00:01:00.000Z",
      });
      await repositories.usageAdmission.reserve({
        ...makeReservationRequest("attempt-expired-2", 0.1),
        expiresAt: "2026-01-15T00:01:00.000Z",
      });

      expect(
        await repositories.usageLedger.recoverExpired(
          "2026-01-15T00:02:00.000Z",
          1,
        ),
      ).toBe(1);
      const firstRecovery = await repositories.usageLedger.list();
      expect(
        firstRecovery.filter(
          (entry) => entry.errorCode === "admission-expired",
        ),
      ).toHaveLength(1);
      expect(
        firstRecovery.filter((entry) => entry.outcome === "admitted"),
      ).toHaveLength(1);
      await repositories.usageAdmin.query({
        userId: "admin-1",
        role: "admin",
      });
      expect(
        (await repositories.usageLedger.list()).filter(
          (entry) => entry.outcome === "admitted",
        ),
      ).toHaveLength(1);
      expect(
        await repositories.usageLedger.recoverExpired(
          "2026-01-15T00:02:00.000Z",
          1,
        ),
      ).toBe(1);
      expect(
        await repositories.usageLedger.recoverExpired(
          "2026-01-15T00:02:00.000Z",
          1,
        ),
      ).toBe(0);
      expect(
        await repositories.usageAdmin.query({
          userId: "admin-1",
          role: "admin",
        }),
      ).toMatchObject({
        totals: {
          unknownExposureUsd: reservation.reservedUsd * 2,
          attempts: 2,
        },
      });
      await repositories.usageAdmission.settle({
        reservation,
        outcome: "success",
        units: {
          input: 100,
          output: 100,
          total: 200,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          search: 0,
        },
        errorCode: null,
        at: "2026-01-15T00:03:00.000Z",
      });
      const settledEntries = await repositories.usageLedger.list();
      expect(
        settledEntries.find((entry) => entry.attemptId === "attempt-expired"),
      ).toMatchObject({
        outcome: "success",
        reservationStatus: "settled",
        costStatus: "estimated",
      });
    });

    it("fences run concurrency and retains the case lock while waiting", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.cases.insert(makeCase("case-2", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-2", "case-2", "owner-1"));
      const request = {
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "lease-1",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 2,
      };
      const firstLease = await repositories.runAdmission.acquire(request);
      await expect(
        repositories.runAdmission.acquire({
          ...request,
          caseId: "case-2",
          runId: "run-2",
          leaseId: "lease-2",
        }),
      ).rejects.toMatchObject({ code: "run-concurrency-limit" });

      const waitingFence = await repositories.runAdmission.waitForInput({
        ...request,
        fencingToken: firstLease.fencingToken,
      });
      expect(waitingFence).toBe(firstLease.fencingToken + 1);
      expect(
        await repositories.runs.findOwnedById("run-1", "owner-1"),
      ).toMatchObject({
        status: "waiting-for-input",
        inputRequired: true,
        fencingToken: waitingFence,
      });
      await expect(
        repositories.runs.insert(makeRun("run-3", "case-1", "owner-1")),
      ).rejects.toMatchObject({ code: "duplicate-record" });

      const secondLease = await repositories.runAdmission.acquire({
        ...request,
        caseId: "case-2",
        runId: "run-2",
        leaseId: "lease-2",
      });
      expect(secondLease.fencingToken).toBe(1);
      await repositories.runAdmission.release({
        ...request,
        caseId: "case-2",
        runId: "run-2",
        leaseId: secondLease.leaseId,
        fencingToken: secondLease.fencingToken,
        at: "2026-01-15T00:02:00.000Z",
      });

      const resumed = await repositories.runAdmission.resume({
        ...request,
        leaseId: "lease-1-resumed",
        at: "2026-01-15T00:03:00.000Z",
        expiresAt: "2026-01-15T00:18:00.000Z",
        fencingToken: firstLease.fencingToken + 1,
      });
      expect(resumed.fencingToken).toBe(firstLease.fencingToken + 2);
      expect(
        await repositories.runAdmission.release({
          ...request,
          leaseId: firstLease.leaseId,
          fencingToken: firstLease.fencingToken,
          at: "2026-01-15T00:04:00.000Z",
        }),
      ).toBe(false);
      expect(
        await repositories.runAdmission.release({
          ...request,
          leaseId: resumed.leaseId,
          fencingToken: resumed.fencingToken,
          at: "2026-01-15T00:04:00.000Z",
        }),
      ).toBe(true);
    });

    it("renews only an active lease with the current fencing token", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const lease = await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "lease-1",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });
      const staleRun = await repositories.runs.findOwnedById(
        "run-1",
        "owner-1",
      );
      if (!staleRun) throw new Error("Run disappeared after admission");

      expect(
        await repositories.runAdmission.renew({
          ownerId: "owner-1",
          caseId: "case-1",
          runId: "run-1",
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          at: "2026-01-15T00:01:00.000Z",
          expiresAt: "2026-01-15T00:30:00.000Z",
        }),
      ).toMatchObject({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
        expiresAt: "2026-01-15T00:30:00.000Z",
      });
      expect(
        await repositories.runs.updateOwned(
          { ...staleRun, updatedAt: "2026-01-15T00:02:00.000Z" },
          "owner-1",
        ),
      ).toBe(false);
      expect(
        await repositories.runAdmission.renew({
          ownerId: "owner-1",
          caseId: "case-1",
          runId: "run-1",
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken + 1,
          at: "2026-01-15T00:02:00.000Z",
          expiresAt: "2026-01-15T00:31:00.000Z",
        }),
      ).toBeNull();
    });

    it("rejects waiting transitions after cancellation is requested", async () => {
      await repositories.cases.insert(makeCase("case-1", "owner-1"));
      await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
      const lease = await repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "lease-1",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });
      const run = await repositories.runs.findOwnedById("run-1", "owner-1");
      if (!run) throw new Error("Run disappeared after admission");
      expect(
        await repositories.runs.updateOwned(
          { ...run, cancellationRequested: true },
          "owner-1",
        ),
      ).toBe(true);

      expect(
        await repositories.runAdmission.waitForInput({
          ownerId: "owner-1",
          caseId: "case-1",
          runId: "run-1",
          leaseId: lease.leaseId,
          fencingToken: lease.fencingToken,
          at: "2026-01-15T00:01:00.000Z",
        }),
      ).toBeNull();
      expect(
        await repositories.runs.findOwnedById("run-1", "owner-1"),
      ).toMatchObject({ status: "running", cancellationRequested: true });
    });
  });
}

describe("in-memory repositories", () => {
  repositoryContract("repository contract", async () => {
    const store = createInMemoryStore();
    return {
      repositories: store.repositories,
      close: async () => undefined,
    };
  });

  it("returns all usage ledger attempts for a run beyond the admin page cap", async () => {
    const store = createInMemoryStore();
    const { repositories } = store;
    await repositories.cases.insert(makeCase("case-1", "owner-1"));
    await repositories.runs.insert(makeRun("run-1", "case-1", "owner-1"));
    const lease = await repositories.runAdmission.acquire({
      ownerId: "owner-1",
      caseId: "case-1",
      runId: "run-1",
      leaseId: "history-lease",
      at: timestamp,
      expiresAt: "2027-01-15T00:15:00.000Z",
      userLimit: 1,
      globalLimit: 1,
    });
    await repositories.usagePrices.insert(makeUsagePrice());
    for (let index = 0; index < 5_001; index += 1) {
      await repositories.usageAdmission.reserve({
        ...makeReservationRequest(`history-${index}`, 0.000001),
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      });
    }

    expect(
      await repositories.usage.listForRun("run-1", ownerScope),
    ).toHaveLength(5_001);
  });
});

describe("MongoDB repositories", () => {
  beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
    });
  }, 300_000);

  afterAll(async () => {
    await mongoReplSet?.stop();
  }, 30_000);

  repositoryContract("repository contract", async () => {
    const harness = await createMongoHarness();
    return {
      repositories: harness.store.repositories as ReturnType<
        typeof createInMemoryStore
      >["repositories"],
      close: async () => {
        await harness.client.db(harness.dbName).dropDatabase();
        await harness.store.close();
      },
    };
  });

  it("paginates cases by instant time, not timestamp string ordering", async () => {
    const harness = await createMongoHarness(1);
    try {
      await harness.store.repositories.cases.insert(
        makeCase("B", "owner-1", {
          createdAt: "2026-01-15T01:00:00+02:00",
        }),
      );
      await harness.store.repositories.cases.insert(
        makeCase("a", "owner-1", { createdAt: "2026-01-14T23:00:00Z" }),
      );
      await harness.store.repositories.cases.insert(
        makeCase("C", "owner-1", {
          createdAt: "2026-01-15T00:00:00-05:00",
        }),
      );

      const pageIds: string[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 3; index += 1) {
        const page = await harness.store.repositories.cases.listOwned(
          "owner-1",
          cursor,
        );
        pageIds.push(...page.map((record) => record.id));
        cursor = page[0]?.id;
      }

      expect(pageIds).toEqual(["C", "a", "B"]);
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("aborts all writes when a transaction fails", async () => {
    const harness = await createMongoHarness();
    try {
      await expect(
        harness.store.withTransaction(async (session) => {
          await harness.store.cases.insertOne(
            {
              _id: "transaction-case",
              id: "transaction-case",
              ...makeCase("transaction-case", "owner-1"),
            },
            { session },
          );
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(
        await harness.store.cases.findOne({ _id: "transaction-case" }),
      ).toBeNull();
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("keeps null and string none extraction cache identities separate", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.documents.insert(
        {
          id: "document-cache",
          caseId: "case-1",
          name: "source.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          state: "ready",
          uploadedAt: timestamp,
          processedAt: null,
          objectKey: "object-key",
          contentHash: "content-hash",
        },
        ownerScope,
      );
      const extraction: ExtractedDocument = {
        documentId: "document-cache",
        kind: "text",
        method: "parse",
        confidence: 1,
        pages: [],
        tables: [],
        warnings: [],
        cacheIdentity: {
          contentHash: "content-hash",
          extractorVersion: "1",
          modelVersion: null,
        },
      };
      await harness.store.repositories.extractions.saveForDocument(
        extraction,
        ownerScope,
      );
      await harness.store.repositories.extractions.saveForDocument(
        {
          ...extraction,
          cacheIdentity: {
            ...extraction.cacheIdentity,
            modelVersion: "none",
          },
        },
        ownerScope,
      );

      expect(
        await harness.store.extractions.countDocuments({
          caseId: "case-1",
          documentId: "document-cache",
        }),
      ).toBe(2);
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("uses fencing tokens when expired run leases are reclaimed", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-1", "case-1", "owner-1"),
      );
      const request = {
        runId: "run-1",
        ownerId: "owner-1",
        leaseId: "lease-1",
        expiresAt: "2026-01-15T00:03:00.000Z",
        at: timestamp,
      };
      expect(await harness.store.acquireRunLease(request)).toBeNull();
      const firstLease = await harness.store.repositories.runAdmission.acquire({
        ...request,
        caseId: "case-1",
        expiresAt: "2026-01-15T00:05:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });
      expect(firstLease.fencingToken).toBe(1);
      const first = await harness.store.repositories.runs.findOwnedById(
        "run-1",
        "owner-1",
      );
      if (!first) throw new Error("Run disappeared after admission");
      expect(
        await harness.store.runs.updateOne(
          { _id: "run-1" },
          { $set: { leaseExpiresAt: "2026-01-15T00:01:00.000Z" } },
        ),
      ).toMatchObject({ matchedCount: 1, modifiedCount: 1 });
      await expect(
        harness.store.acquireRunLease({ ...request, leaseId: "" }),
      ).rejects.toThrow();
      await expect(
        harness.store.acquireRunLease({
          ...request,
          expiresAt: "not-a-date",
        }),
      ).rejects.toThrow();
      await expect(
        harness.store.acquireRunLease({ ...request, expiresAt: timestamp }),
      ).rejects.toThrow();
      expect(
        await harness.store.repositories.runs.findOwnedById("run-1", "owner-1"),
      ).toMatchObject({ fencingToken: 1, leaseId: "lease-1" });
      expect(
        await harness.store.acquireRunLease({
          ...request,
          leaseId: "lease-2",
          at: "2026-01-15T00:00:30.000Z",
        }),
      ).toBeNull();
      const reclaimed = await harness.store.acquireRunLease({
        ...request,
        leaseId: "lease-2",
        expiresAt: "2026-01-15T00:03:00.000Z",
        at: "2026-01-15T00:02:00.000Z",
      });
      expect(reclaimed?.fencingToken).toBe(2);
      expect(reclaimed?.leaseId).toBe("lease-2");
      expect(
        await harness.store.acquireRunLease({
          ...request,
          leaseId: "lease-3",
          expiresAt: "2026-01-15T01:02:00.000Z",
          at: "2026-01-15T01:00:00.000Z",
        }),
      ).toBeNull();
      expect(
        await harness.store.repositories.runs.updateOwned(
          {
            ...first,
            status: "completed",
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: "2026-01-15T00:02:30.000Z",
          },
          "owner-1",
        ),
      ).toBe(false);
      expect(
        await harness.store.repositories.runs.findOwnedById("run-1", "owner-1"),
      ).toMatchObject({
        status: "running",
        fencingToken: 2,
        leaseId: "lease-2",
      });
      const staleEvent = {
        id: "event-stale",
        caseId: "case-1",
        runId: "run-1",
        sequence: 1,
        occurredAt: timestamp,
        payload: { type: "run-started" as const, planVersion: 1 },
      };
      await expect(
        harness.store.repositories.events.append(
          staleEvent,
          { ownerId: "owner-1", caseId: "case-1" },
          { fencingToken: 1 },
        ),
      ).rejects.toMatchObject({ code: "stale-fencing-token" });
      await harness.store.repositories.events.append(
        staleEvent,
        { ownerId: "owner-1", caseId: "case-1" },
        { fencingToken: 2 },
      );
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("backfills active case keys for waiting runs before enforcing uniqueness", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.cases.insert(
        makeCase("case-completed", "owner-1"),
      );
      await harness.store.repositories.runs.insert({
        ...makeRun("run-1", "case-1", "owner-1"),
        status: "waiting-for-input",
        inputRequired: true,
      });
      await harness.store.repositories.runs.insert({
        ...makeRun("run-completed", "case-completed", "owner-1"),
        status: "completed",
      });
      await harness.store.runs.updateOne(
        { _id: "run-1" },
        { $unset: { activeCaseKey: "" } },
      );

      await harness.store.initialize();

      expect(await harness.store.runs.findOne({ _id: "run-1" })).toMatchObject({
        activeCaseKey: JSON.stringify(["owner-1", "case-1"]),
      });
      expect(
        await harness.store.repositories.runAdmission.resume({
          ownerId: "owner-1",
          caseId: "case-1",
          runId: "run-1",
          leaseId: "resumed-lease",
          at: timestamp,
          expiresAt: "2026-01-15T00:15:00.000Z",
          userLimit: 1,
          globalLimit: 1,
          fencingToken: 0,
        }),
      ).toMatchObject({ fencingToken: 1 });
      expect(
        await harness.store.runs.findOne({ _id: "run-completed" }),
      ).not.toHaveProperty("activeCaseKey");
      await expect(
        harness.store.repositories.runs.insert(
          makeRun("run-2", "case-1", "owner-1"),
        ),
      ).rejects.toMatchObject({ code: "duplicate-record" });
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("fails initialization explicitly when active runs conflict during key migration", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-1", "case-1", "owner-1"),
      );
      await harness.store.runs.updateOne(
        { _id: "run-1" },
        { $unset: { activeCaseKey: "" } },
      );
      const conflictingRun = {
        ...makeRun("run-2", "case-1", "owner-1"),
        _id: "run-2",
      };
      await harness.store.runs.insertOne(conflictingRun);

      await expect(harness.store.initialize()).rejects.toMatchObject({
        code: "active-run-migration-conflict",
      });
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("backfills existing active run leases and their concurrency counters", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-live", "owner-1"),
      );
      await harness.store.repositories.cases.insert(
        makeCase("case-next", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-live", "case-live", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-next", "case-next", "owner-1"),
      );
      await harness.store.runs.updateOne(
        { _id: "run-live" },
        {
          $set: {
            leaseId: "legacy-lease",
            leaseExpiresAt: "2099-01-15T00:15:00.000Z",
            fencingToken: 4,
          },
        },
      );

      await harness.store.initialize();
      await harness.store.initialize();

      expect(
        await harness.client
          .db(harness.dbName)
          .collection("runAdmissions")
          .findOne({
            _id: JSON.stringify(["owner-1", "case-live"]),
          }),
      ).toMatchObject({
        runId: "run-live",
        state: "active",
        leaseId: "legacy-lease",
        fencingToken: 4,
      });
      expect(
        await harness.client
          .db(harness.dbName)
          .collection("runAdmissionCounters")
          .findOne({ _id: "global" }),
      ).toMatchObject({ activeRuns: 1 });
      await expect(
        harness.store.repositories.runAdmission.acquire({
          ownerId: "owner-1",
          caseId: "case-next",
          runId: "run-next",
          leaseId: "next-lease",
          at: timestamp,
          expiresAt: "2026-01-15T00:15:00.000Z",
          userLimit: 1,
          globalLimit: 1,
        }),
      ).rejects.toMatchObject({ code: "run-concurrency-limit" });
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("compares Mongo usage timestamps as instants for prices and ledger filters", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-1", "case-1", "owner-1"),
      );
      await harness.store.repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "usage-lease",
        at: timestamp,
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 2,
        globalLimit: 2,
      });
      const price = makeUsagePrice();
      await harness.store.repositories.usagePrices.insert(price);
      const laterPrice = {
        ...price,
        id: "price-later",
        version: 2,
        effectiveAt: "2026-01-15T00:01:00-05:00",
      };
      await harness.store.repositories.usagePrices.insert(laterPrice);
      await harness.client
        .db(harness.dbName)
        .collection("usagePrices")
        .updateOne(
          { _id: laterPrice.id },
          { $set: { effectiveAt: laterPrice.effectiveAt } },
        );
      expect(
        await harness.store.repositories.usagePrices.findActive(
          "muse",
          "spark",
          "settings-v1",
          "2026-01-15T01:00:00.000Z",
        ),
      ).toMatchObject({ id: "price-v1" });
      expect(
        await harness.store.repositories.usagePrices.findActive(
          "muse",
          "spark",
          "settings-v1",
          "2026-01-15T06:00:00.000Z",
        ),
      ).toMatchObject({ id: "price-later" });

      const reservation =
        await harness.store.repositories.usageAdmission.reserve({
          ...makeReservationRequest("attempt-timestamp", 0.1),
          price: {
            ...price,
            effectiveAt: "2026-01-01T05:30:00+05:30",
          },
        });
      const ledgerIndexes = await harness.client
        .db(harness.dbName)
        .collection("usageLedger")
        .listIndexes()
        .toArray();
      expect(
        ledgerIndexes.some(
          (index) =>
            index.key.createdAtInstant === -1 &&
            index.key.attemptId === -1 &&
            Object.keys(index.key).length === 2,
        ),
      ).toBe(true);
      await harness.client
        .db(harness.dbName)
        .collection("usageLedger")
        .updateOne(
          { _id: reservation.attemptId },
          {
            $set: {
              createdAt: "2026-01-15T00:00:00-05:00",
            },
            $unset: { createdAtInstant: "" },
          },
        );
      await harness.store.initialize();
      expect(
        await harness.store.repositories.usageLedger.list({
          from: "2026-01-15T04:00:00.000Z",
          to: "2026-01-15T06:00:00.000Z",
        }),
      ).toHaveLength(1);
      expect(
        await harness.store.repositories.usageLedger.list({
          from: "2026-01-15T02:00:00.000Z",
          to: "2026-01-15T04:00:00.000Z",
        }),
      ).toHaveLength(0);
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("returns all Mongo usage ledger attempts for a run beyond the admin page cap", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-1", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-1", "case-1", "owner-1"),
      );
      const lease = await harness.store.repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-1",
        runId: "run-1",
        leaseId: "history-lease",
        at: timestamp,
        expiresAt: "2027-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });
      await harness.store.repositories.usagePrices.insert(makeUsagePrice());
      await harness.store.repositories.usageAdmission.reserve({
        ...makeReservationRequest("history-base", 0.000001),
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken,
      });
      const base = (
        await harness.store.repositories.usageLedger.list({
          limit: 1,
        })
      )[0];
      if (!base) throw new Error("Usage ledger entry was not written");
      const extra = Array.from({ length: 5_001 }, (_, index) => {
        const attemptId = `history-${index}`;
        return {
          ...base,
          _id: attemptId,
          id: attemptId,
          attemptId,
          createdAtInstant: new Date(Date.parse(base.createdAt)),
        };
      });
      await harness.client
        .db(harness.dbName)
        .collection("usageLedger")
        .insertMany(extra);

      expect(
        await harness.store.repositories.usage.listForRun("run-1", ownerScope),
      ).toHaveLength(5_002);
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });

  it("reaps expired admissions in committed batches before capacity checks", async () => {
    const harness = await createMongoHarness();
    try {
      await harness.store.repositories.cases.insert(
        makeCase("case-live", "owner-1"),
      );
      await harness.store.repositories.runs.insert(
        makeRun("run-live", "case-live", "owner-1"),
      );
      const database = harness.client.db(harness.dbName);
      const locks = Array.from({ length: 1_001 }, (_, index) => {
        const caseId = `expired-case-${index}`;
        return {
          _id: JSON.stringify(["owner-1", caseId]),
          ownerId: "owner-1",
          caseId,
          runId: `expired-run-${index}`,
          state: "active",
          leaseId: `expired-lease-${index}`,
          fencingToken: 1,
          leaseExpiresAt: "2026-01-14T23:00:00.000Z",
          updatedAt: timestamp,
        };
      });
      await database.collection("runAdmissions").insertMany(locks);
      await database.collection("runAdmissionCounters").insertMany([
        { _id: "user:owner-1", activeRuns: locks.length },
        { _id: "global", activeRuns: locks.length },
      ]);

      const lease = await harness.store.repositories.runAdmission.acquire({
        ownerId: "owner-1",
        caseId: "case-live",
        runId: "run-live",
        leaseId: "live-lease",
        at: "2026-01-15T00:01:00.000Z",
        expiresAt: "2026-01-15T00:15:00.000Z",
        userLimit: 1,
        globalLimit: 1,
      });

      expect(lease.fencingToken).toBe(1);
      expect(
        await database
          .collection("runAdmissionCounters")
          .findOne({ _id: "global" }),
      ).toMatchObject({ activeRuns: 1 });
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  }, 30_000);
});
