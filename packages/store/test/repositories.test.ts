import {
  CaseSchema,
  syntheticWorkflowFixtures,
  type Case,
  type Deliverable,
  type ExtractedDocument,
  type OwnerScope,
  type RunRecord,
  type UsageRecord,
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
import { getMongoDatabaseName, MongoStore } from "../src/mongo.js";

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

    it("extracts database names from replica-set MongoDB URIs", () => {
      expect(
        getMongoDatabaseName(
          "mongodb://db1:27017,db2:27017/evianta?replicaSet=rs0",
        ),
      ).toBe("evianta");
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
        issuedAt: timestamp,
        expiresAt: "2026-01-15T01:00:00+02:00",
        revokedAt: null,
        createdAt: timestamp,
      });
      await repositories.sessions.insert({
        id: "session-valid",
        userId: "user-1",
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
        lastUsedAt: null,
        revokedAt: null,
        createdAt: timestamp,
      });
      await repositories.sessions.insert({
        id: "session-1",
        userId: "user-1",
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
});

describe("MongoDB repositories", () => {
  beforeAll(async () => {
    mongoReplSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
    });
  }, 300_000);

  afterAll(async () => {
    await mongoReplSet?.stop();
  });

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
      const lease = {
        runId: "run-1",
        ownerId: "owner-1",
        leaseId: "lease-1",
        expiresAt: "2026-01-15T00:01:00-05:00",
        at: timestamp,
      };
      const first = await harness.store.acquireRunLease(lease);
      expect(first?.fencingToken).toBe(1);
      await expect(
        harness.store.acquireRunLease({ ...lease, leaseId: "" }),
      ).rejects.toThrow();
      await expect(
        harness.store.acquireRunLease({
          ...lease,
          expiresAt: "not-a-date",
        }),
      ).rejects.toThrow();
      await expect(
        harness.store.acquireRunLease({ ...lease, expiresAt: timestamp }),
      ).rejects.toThrow();
      expect(
        await harness.store.repositories.runs.findOwnedById("run-1", "owner-1"),
      ).toMatchObject({ fencingToken: 1, leaseId: "lease-1" });
      expect(
        await harness.store.acquireRunLease({
          ...lease,
          leaseId: "lease-2",
          at: "2026-01-15T00:00:30.000Z",
        }),
      ).toBeNull();
      expect(
        await harness.store.acquireRunLease({
          ...lease,
          leaseId: "lease-2",
          at: "2026-01-15T01:00:00.000Z",
        }),
      ).toBeNull();
      const reclaimed = await harness.store.acquireRunLease({
        ...lease,
        leaseId: "lease-2",
        expiresAt: "2026-01-15T05:03:00.000Z",
        at: "2026-01-15T05:02:00.000Z",
      });
      expect(reclaimed?.fencingToken).toBe(2);
      expect(reclaimed?.leaseId).toBe("lease-2");
      expect(first).not.toBeNull();
      expect(
        await harness.store.repositories.runs.updateOwned(
          {
            ...first!,
            status: "completed",
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: "2026-01-15T05:02:30.000Z",
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
    } finally {
      await harness.client.db(harness.dbName).dropDatabase();
      await harness.store.close();
    }
  });
});
