import {
  AccessKeyRecordSchema,
  AgentProfileSchema,
  ApprovalSchema,
  CaseSchema,
  DeliverableSchema,
  DocumentMetadataDtoSchema,
  DocumentMetadataRecordSchema,
  EvidenceSchema,
  ExtractedDocumentSchema,
  FindingSchema,
  RunEventSchema,
  RunRecordSchema,
  SessionRecordSchema,
  TaskSchema,
  summarizeUsage,
  UsageLedgerEntrySchema,
  TaskPlanSchema,
  UserRecordSchema,
  UsageRecordSchema,
  type AccessKeyRecord,
  type AgentProfile,
  type Approval,
  type Case,
  type Deliverable,
  type DocumentMetadataDto,
  type DocumentMetadataRecord,
  type ExpectedDocumentSource,
  type Evidence,
  type ExtractedDocument,
  type ExtractionCacheIdentity,
  type ExtractionClaimRequest,
  type Finding,
  type OwnerScope,
  type RunEvent,
  type RunRecord,
  type SessionRecord,
  type Task,
  type UserRecord,
  type UsageRecord,
  type UsageAdmissionPort,
  type UsageLedgerRepository,
  type UsagePriceRepository,
  type UsageReservation,
  type AgentProfileRepository,
  type AccessKeyRepository,
  type ApprovalRepository,
  type CaseRepository,
  type DeliverableRepository,
  type DocumentRepository,
  type EvidenceRepository,
  type ExtractionRepository,
  type FindingRepository,
  type RunEventRepository,
  type RunRepository,
  type RunAdmissionPort,
  type SessionRepository,
  type TaskRepository,
  type UserRepository,
  type UsageRepository,
  type RateLimitRepository,
} from "@evianta/core";
import {
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  type OptionalUnlessRequiredId,
  MongoServerError,
} from "mongodb";
import { getMongoConfig, type MongoConfig } from "@evianta/env/server";
import { z, type ZodType } from "zod";
import { MongoUsageRepository } from "./usage-mongo.js";
import { MongoRunAdmissionRepository } from "./run-admission-mongo.js";
import { UsageAdminService } from "./usage-admin.js";
import {
  CaseNotOwnedError,
  InvalidCursorError,
  SequenceConflictError,
  StoreError,
} from "./errors.js";

export {
  CaseNotOwnedError,
  InvalidCursorError,
  SequenceConflictError,
  StoreError,
} from "./errors.js";
import {
  MongoRateLimitRepository,
  type MongoRateLimitCounter,
} from "./rate-limits.js";

type Stored<T> = T & Document & { _id: string };
const TimestampSchema = z.string().datetime({ offset: true });
const MongoRunLeaseSchema = z
  .object({
    runId: z.string().min(1),
    ownerId: z.string().min(1),
    leaseId: z.string().min(1),
    expiresAt: TimestampSchema,
    at: TimestampSchema,
  })
  .refine(
    (request) => Date.parse(request.expiresAt) > Date.parse(request.at),
    "Lease expiry must be after acquisition time",
  );

function documentFor<T extends { id: string }>(record: T): Stored<T> {
  return { ...record, _id: record.id } as Stored<T>;
}

function decode<T>(schema: ZodType<T>, document: Document | null): T | null {
  if (!document) return null;
  const record = { ...document };
  delete record._id;
  return schema.parse(record);
}

function indexValue<T extends { id: string }>(
  schema: ZodType<T>,
  record: T,
): Stored<T> {
  const parsed = schema.parse(record);
  return { ...record, ...parsed, _id: parsed.id } as Stored<T>;
}

function activeCaseKey(ownerId: string, caseId: string): string {
  return JSON.stringify([ownerId, caseId]);
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function extractionCacheId(record: {
  documentId: string;
  cacheIdentity: ExtractionCacheIdentity;
}): string {
  return [
    record.documentId,
    record.cacheIdentity.contentHash,
    record.cacheIdentity.extractorVersion,
    record.cacheIdentity.modelVersion ?? "",
  ]
    .map(encodeURIComponent)
    .join(":");
}

async function insertUnique<T extends { id: string }>(
  collection: Collection<Stored<T>>,
  schema: ZodType<T>,
  record: T & Document,
  session?: ClientSession,
): Promise<void> {
  try {
    await collection.insertOne(
      indexValue(schema, record) as OptionalUnlessRequiredId<Stored<T>>,
      { session },
    );
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new StoreError(
        "A record with the same identity already exists",
        "duplicate-record",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

export interface MongoStoreOptions {
  client: MongoClient;
  db: Db;
  pageSize?: number;
}

export interface MongoRunLease {
  runId: string;
  ownerId: string;
  leaseId: string;
  expiresAt: string;
  at: string;
}

export class MongoStore {
  readonly client: MongoClient;
  readonly databaseName: string;
  readonly agents: Collection<Stored<AgentProfile>>;
  readonly users: Collection<Stored<UserRecord>>;
  readonly accessKeys: Collection<Stored<AccessKeyRecord>>;
  readonly sessions: Collection<Stored<SessionRecord>>;
  readonly cases: Collection<Stored<Case> & { createdAtInstant?: Date }>;
  readonly documents: Collection<Stored<DocumentMetadataRecord>>;
  readonly extractions: Collection<
    Stored<ExtractedDocument> & {
      caseId: string;
      cachedAt: string;
      revision?: number;
    }
  >;
  readonly extractionCounters: Collection<
    Stored<{ id: string; revision: number }>
  >;
  readonly extractionClaims: Collection<{
    _id: string;
    documentId: string;
    caseId: string;
    ownerId: string;
    holderId: string;
    claimedAt: Date;
    expiresAt: Date;
    committedAt?: Date;
  }>;
  readonly tasks: Collection<Stored<Task>>;
  readonly findings: Collection<Stored<Finding>>;
  readonly evidence: Collection<Stored<Evidence>>;
  readonly deliverables: Collection<
    Stored<Deliverable> & { approvalRevision?: number }
  >;
  readonly approvals: Collection<Stored<Approval>>;
  readonly runs: Collection<Stored<RunRecord> & { activeCaseKey?: string }>;
  private readonly runAdmissions: Collection<Document>;
  readonly events: Collection<Stored<RunEvent>>;
  readonly eventCounters: Collection<Stored<{ id: string; sequence: number }>>;
  readonly usageAttempts: Collection<Stored<UsageRecord>>;
  readonly reservations: Collection<
    Stored<UsageReservation> & { idempotencyKey: string }
  >;
  readonly budgets: Collection<Document>;
  readonly rateLimits: MongoRateLimitRepository;
  private readonly pageSize: number;
  readonly repositories: {
    agentProfiles: AgentProfileRepository;
    cases: CaseRepository;
    users: UserRepository;
    accessKeys: AccessKeyRepository;
    sessions: SessionRepository;
    documents: DocumentRepository;
    extractions: ExtractionRepository;
    evidence: EvidenceRepository;
    findings: FindingRepository;
    tasks: TaskRepository;
    runs: RunRepository;
    deliverables: DeliverableRepository;
    approvals: ApprovalRepository;
    events: RunEventRepository;
    usage: UsageRepository;
    usageAdmission: UsageAdmissionPort;
    usagePrices: UsagePriceRepository;
    usageLedger: UsageLedgerRepository;
    runAdmission: RunAdmissionPort;
    usageAdmin: UsageAdminService;
    rateLimits: RateLimitRepository;
  };
  private readonly usageAccounting: MongoUsageRepository;
  private readonly runAdmissionRepository: MongoRunAdmissionRepository;
  private usageRecoveryTimer: ReturnType<typeof setInterval> | undefined;
  private usageRecoveryTask: Promise<void> | undefined;

  constructor(private readonly options: MongoStoreOptions) {
    const { db } = options;
    this.client = options.client;
    this.databaseName = db.databaseName;
    this.pageSize = options.pageSize ?? 50;
    this.agents = db.collection("agents");
    this.users = db.collection("users");
    this.accessKeys = db.collection("accessKeys");
    this.sessions = db.collection("sessions");
    this.cases = db.collection("cases");
    this.documents = db.collection("documents");
    this.extractions = db.collection("extractions");
    this.extractionCounters = db.collection("extractionCounters");
    this.extractionClaims = db.collection("extractionClaims");
    this.tasks = db.collection("tasks");
    this.findings = db.collection("findings");
    this.evidence = db.collection("evidence");
    this.deliverables = db.collection("deliverables");
    this.approvals = db.collection("approvals");
    this.runs = db.collection("runs");
    this.runAdmissions = db.collection("runAdmissions");
    this.events = db.collection("events");
    this.eventCounters = db.collection("eventCounters");
    this.usageAttempts = db.collection("usageAttempts");
    this.reservations = db.collection("usageReservations");
    this.budgets = db.collection("budgets");
    this.usageAccounting = new MongoUsageRepository(options.client, db);
    this.runAdmissionRepository = new MongoRunAdmissionRepository(
      options.client,
      db,
    );
    this.rateLimits = new MongoRateLimitRepository(
      db.collection<MongoRateLimitCounter>("rateLimitCounters"),
      (message, code) => new StoreError(message, code),
    );
    this.repositories = {
      agentProfiles: {
        listEnabled: () => this.agentListEnabled(),
        findByRole: (role) => this.agentFindByRole(role),
        upsert: (profile) => this.agentUpsert(profile),
      },
      cases: {
        refreshUsage: (scope, request) => this.caseRefreshUsage(scope, request),
        findOwnedById: (id, ownerId) => this.caseFindOwnedById(id, ownerId),
        findPublicSampleById: (id) => this.caseFindPublicSampleById(id),
        listOwned: (ownerId, cursor) => this.caseListOwned(ownerId, cursor),
        insert: (record) => this.caseInsert(record),
        replaceOwned: (record, ownerId) =>
          this.caseReplaceOwned(record, ownerId),
      },
      users: {
        findById: (id) => this.userFindById(id),
        findByEmail: (email) => this.userFindByEmail(email),
        insert: (user) => this.userInsert(user),
        replace: (user) => this.userReplace(user),
      },
      accessKeys: {
        findActiveById: (id, at) => this.accessKeyFindActiveById(id, at),
        insert: (record) => this.accessKeyInsert(record),
        revoke: (id, at) => this.accessKeyRevoke(id, at),
        markUsed: (id, at) => this.accessKeyMarkUsed(id, at),
      },
      sessions: {
        findActiveById: (id, at) => this.sessionFindActiveById(id, at),
        insert: (record) => this.sessionInsert(record),
        revoke: (id, at) => this.sessionRevoke(id, at),
      },
      documents: {
        findOwned: (id, scope) => this.documentFindOwned(id, scope),
        listOwned: (scope) => this.documentListOwned(scope),
        insert: (record, scope) => this.documentInsert(record, scope),
        replaceOwned: (record, scope, expectedSource, claim) =>
          this.documentReplaceOwned(record, scope, expectedSource, claim),
      },
      extractions: {
        findForDocument: (id, scope) =>
          this.extractionFindForDocument(id, scope),
        saveForDocument: async (record, scope) => {
          await this.extractionSaveForDocument(record, scope);
        },
        saveClaimed: (record, document, claim, scope) =>
          this.extractionSaveForDocument(record, scope, { document, ...claim }),
        findCached: (id, identity, scope) =>
          this.extractionFindCached(id, identity, scope),
        claim: (request, scope) => this.extractionClaim(request, scope),
        renewClaim: (request, scope, options) =>
          this.extractionRenewClaim(request, scope, options),
        releaseClaim: (request, scope) =>
          this.extractionReleaseClaim(request, scope),
        deleteForCase: (scope) => this.extractionDeleteForCase(scope),
      },
      evidence: {
        listForCase: (scope) => this.evidenceListForCase(scope),
        insert: (record, scope) => this.evidenceInsert(record, scope),
      },
      findings: {
        listForCase: (scope) => this.findingListForCase(scope),
        insert: (record, scope) => this.findingInsert(record, scope),
      },
      tasks: {
        insertPlan: (tasks, scope, options) =>
          this.taskInsertPlan(tasks, scope, options),
        commitResult: (task, result, scope, options) =>
          this.taskReplaceOwned(task, scope, options, result),
        listForRun: (id, scope) => this.taskListForRun(id, scope),
        insert: (record, scope) => this.taskInsert(record, scope),
        replaceOwned: (record, scope, options) =>
          this.taskReplaceOwned(record, scope, options),
      },
      runs: {
        findOwnedById: (id, ownerId) => this.runFindOwnedById(id, ownerId),
        listForCase: (caseId, ownerId) => this.runListForCase(caseId, ownerId),
        insert: (record, tasks) => this.runInsert(record, tasks),
        updateOwned: (record, ownerId) => this.runUpdateOwned(record, ownerId),
        listClaimable: (at, limit, after) =>
          this.runListClaimable(at, limit, after),
      },
      deliverables: {
        findOwnedById: (id, scope) => this.deliverableFindOwnedById(id, scope),
        listForRun: (id, scope) => this.deliverableListForRun(id, scope),
        insert: (record, scope) => this.deliverableInsert(record, scope),
        replaceOwned: (record, scope) =>
          this.deliverableReplaceOwned(record, scope),
      },
      approvals: {
        findForDeliverable: (id, scope) =>
          this.approvalFindForDeliverable(id, scope),
        insert: (record, scope) => this.approvalInsert(record, scope),
        invalidateForDeliverable: (id, scope) =>
          this.approvalInvalidateForDeliverable(id, scope),
      },
      events: {
        append: (record, scope, options) =>
          this.eventAppend(record, scope, options),
        listAfter: (caseId, sequence, scope) =>
          this.eventListAfter(caseId, sequence, scope),
      },
      usage: {
        listForRun: (id, scope) => this.usageListForRun(id, scope),
        insert: (record, runId, scope) =>
          this.usageInsert(record, runId, scope),
      },
      usageAdmission: this.usageAccounting,
      usagePrices: this.usageAccounting,
      usageLedger: this.usageAccounting,
      runAdmission: this.runAdmissionRepository,
      usageAdmin: new UsageAdminService(this.usageAccounting),
      rateLimits: this.rateLimits,
    };
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.accessKeys.updateMany(
        { expiresAt: { $exists: false } },
        { $set: { expiresAt: null } },
      ),
      this.sessions.updateMany(
        { accessKeyId: { $exists: false } },
        { $set: { accessKeyId: null } },
      ),
    ]);
    await this.cases.updateMany({ createdAtInstant: { $exists: false } }, [
      {
        $set: {
          createdAtInstant: {
            $dateFromString: { dateString: "$createdAt" },
          },
        },
      },
    ]);
    await this.extractions.updateMany(
      { revision: { $exists: false } },
      { $set: { revision: 0 } },
    );
    await this.usageAccounting.initialize();
    await this.runAdmissionRepository.initialize();
    await this.backfillActiveRunKeys();
    await Promise.all([
      this.agents.createIndex({ role: 1 }, { unique: true }),
      this.users.createIndex({ emailKey: 1 }, { unique: true }),
      this.accessKeys.createIndex({ userId: 1, revokedAt: 1, expiresAt: 1 }),
      this.sessions.createIndex({ userId: 1, expiresAt: 1, revokedAt: 1 }),
      this.sessions.createIndex({ accessKeyId: 1, revokedAt: 1 }),
      this.rateLimits.initialize(),
      this.cases.createIndex({
        ownerId: 1,
        createdAtInstant: -1,
        id: -1,
      }),
      this.documents.createIndex({ caseId: 1, id: 1 }, { unique: true }),
      this.extractions.createIndex(
        {
          documentId: 1,
          "cacheIdentity.contentHash": 1,
          "cacheIdentity.extractorVersion": 1,
          "cacheIdentity.modelVersion": 1,
        },
        { unique: true },
      ),
      this.extractions.createIndex({ caseId: 1, documentId: 1, revision: -1 }),
      this.extractionClaims.createIndex({ caseId: 1 }),
      this.tasks.createIndex({ caseId: 1, runId: 1, id: 1 }, { unique: true }),
      this.tasks.createIndex({ caseId: 1, runId: 1 }),
      this.findings.createIndex({ caseId: 1, id: 1 }, { unique: true }),
      this.evidence.createIndex({ caseId: 1, id: 1 }, { unique: true }),
      this.deliverables.createIndex(
        { caseId: 1, runId: 1, id: 1 },
        { unique: true },
      ),
      this.approvals.createIndex(
        { caseId: 1, deliverableId: 1 },
        { unique: true },
      ),
      this.runs.createIndex(
        { activeCaseKey: 1 },
        { unique: true, sparse: true },
      ),
      this.runs.createIndex({ ownerId: 1, caseId: 1, createdAt: -1 }),
      this.events.createIndex({ caseId: 1, sequence: 1 }, { unique: true }),
      this.events.createIndex({ caseId: 1, id: 1 }, { unique: true }),
      this.usageAttempts.createIndex({ attemptId: 1 }, { unique: true }),
      this.usageAttempts.createIndex({ ownerId: 1, caseId: 1, runId: 1 }),
      this.reservations.createIndex({ idempotencyKey: 1 }, { unique: true }),
      this.reservations.createIndex({ ownerId: 1, caseId: 1, runId: 1 }),
      this.budgets.createIndex(
        { ownerId: 1, periodStart: 1 },
        { unique: true },
      ),
    ]);
    if (!this.usageRecoveryTimer) {
      void this.runUsageRecovery();
      this.usageRecoveryTimer = setInterval(() => {
        void this.runUsageRecovery();
      }, 60_000);
      this.usageRecoveryTimer.unref?.();
    }
  }

  async close(): Promise<void> {
    if (this.usageRecoveryTimer) clearInterval(this.usageRecoveryTimer);
    await this.usageRecoveryTask;
    await this.options.client.close();
  }

  private runUsageRecovery(): Promise<void> {
    if (this.usageRecoveryTask) return this.usageRecoveryTask;
    this.usageRecoveryTask = (async () => {
      try {
        const recovered = await this.usageAccounting.recoverExpired(
          new Date().toISOString(),
        );
        if (recovered > 0) {
          console.info(`Recovered ${recovered} expired usage reservations`);
        }
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.error("Usage reservation recovery failed", { errorName });
      } finally {
        this.usageRecoveryTask = undefined;
      }
    })();
    return this.usageRecoveryTask;
  }

  async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = this.options.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async agentListEnabled(): Promise<AgentProfile[]> {
    const records = await this.agents
      .find({ enabled: true })
      .sort({ role: 1 })
      .toArray();
    return records.map((record) => decode(AgentProfileSchema, record)!);
  }

  async agentFindByRole(role: string): Promise<AgentProfile | null> {
    return decode(AgentProfileSchema, await this.agents.findOne({ role }));
  }

  async agentUpsert(profile: AgentProfile): Promise<void> {
    const parsed = AgentProfileSchema.parse(profile);
    await this.agents.updateOne(
      { role: parsed.role },
      {
        $set: parsed,
        $setOnInsert: { _id: parsed.role },
      },
      { upsert: true },
    );
  }

  async caseFindOwnedById(id: string, ownerId: string): Promise<Case | null> {
    return decode(
      CaseSchema,
      await this.cases.findOne({
        _id: id,
        ownerId,
        isSample: false,
        status: { $ne: "deleted" },
      }),
    );
  }

  async caseFindPublicSampleById(id: string): Promise<Case | null> {
    return decode(
      CaseSchema,
      await this.cases.findOne({
        _id: id,
        isSample: true,
        synthetic: true,
        ownerId: null,
        status: { $ne: "deleted" },
      }),
    );
  }

  async caseListOwned(ownerId: string, cursor?: string): Promise<Case[]> {
    let before: Pick<Case, "createdAt" | "id"> | undefined;
    if (cursor) {
      const cursorRecord = await this.caseFindOwnedById(cursor, ownerId);
      if (!cursorRecord) throw new InvalidCursorError();
      before = cursorRecord;
    }
    const query: Document = {
      ownerId,
      isSample: false,
      status: { $ne: "deleted" },
    };
    if (before) {
      query.$or = [
        { createdAtInstant: { $lt: new Date(before.createdAt) } },
        {
          createdAtInstant: new Date(before.createdAt),
          id: { $lt: before.id },
        },
      ];
    }
    const records = await this.cases
      .find(query)
      .sort({ createdAtInstant: -1, id: -1 })
      .limit(this.pageSize)
      .toArray();
    return records.map((record) => decode(CaseSchema, record)!);
  }

  async caseInsert(record: Case): Promise<void> {
    const parsed = CaseSchema.parse(record);
    await insertUnique(this.cases, CaseSchema, {
      ...parsed,
      createdAtInstant: new Date(parsed.createdAt),
    } as Case & Document);
  }

  async caseReplaceOwned(record: Case, ownerId: string): Promise<boolean> {
    const parsed = CaseSchema.parse(record);
    if (parsed.ownerId !== ownerId || parsed.isSample) return false;
    const result = await this.cases.replaceOne(
      { _id: parsed.id, ownerId, isSample: false },
      { ...documentFor(parsed), createdAtInstant: new Date(parsed.createdAt) },
    );
    return result.matchedCount === 1;
  }

  async caseRefreshUsage(
    scope: OwnerScope,
    request: { runId: string; fencingToken: number; at: string },
  ): Promise<boolean> {
    const at = TimestampSchema.parse(request.at);
    return this.withTransaction(async (session) => {
      const fenced = await this.runs.updateOne(
        {
          _id: request.runId,
          caseId: scope.caseId,
          ownerId: scope.ownerId,
          fencingToken: request.fencingToken,
          status: { $in: ["queued", "running", "waiting-for-input"] },
        },
        { $inc: { usageWrites: 1 } },
        { session },
      );
      if (fenced.matchedCount !== 1) return false;
      const entries = await this.options.db
        .collection("usageLedger")
        .find({ ownerId: scope.ownerId, caseId: scope.caseId }, { session })
        .toArray();
      const usage = summarizeUsage(
        entries.map((entry) => decode(UsageLedgerEntrySchema, entry)!),
      );
      const updated = await this.cases.updateOne(
        {
          _id: scope.caseId,
          ownerId: scope.ownerId,
          isSample: false,
          status: { $ne: "deleted" },
        },
        { $set: { usage, updatedAt: at } },
        { session },
      );
      return updated.matchedCount === 1;
    });
  }

  async userFindById(id: string): Promise<UserRecord | null> {
    return decode(UserRecordSchema, await this.users.findOne({ _id: id }));
  }

  async userFindByEmail(email: string): Promise<UserRecord | null> {
    return decode(
      UserRecordSchema,
      await this.users.findOne({ emailKey: email.trim().toLowerCase() }),
    );
  }

  async userInsert(user: UserRecord): Promise<void> {
    const parsed = UserRecordSchema.parse(user);
    try {
      await this.users.insertOne({
        ...documentFor(parsed),
        emailKey: parsed.email.trim().toLowerCase(),
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new StoreError(
          "A user with this ID or email already exists",
          "duplicate-record",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async userReplace(user: UserRecord): Promise<boolean> {
    const parsed = UserRecordSchema.parse(user);
    try {
      const result = await this.users.replaceOne(
        { _id: parsed.id },
        documentFor({
          ...parsed,
          emailKey: parsed.email.trim().toLowerCase(),
        }),
      );
      return result.matchedCount === 1;
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new StoreError(
          "A user with this email already exists",
          "duplicate-record",
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async accessKeyFindActiveById(
    id: string,
    at = new Date().toISOString(),
  ): Promise<AccessKeyRecord | null> {
    const atDate = new Date(TimestampSchema.parse(at));
    return decode(
      AccessKeyRecordSchema,
      await this.accessKeys.findOne({
        _id: id,
        revokedAt: null,
        $or: [
          { expiresAt: null },
          {
            $expr: {
              $gt: [
                {
                  $dateFromString: {
                    dateString: "$expiresAt",
                    onError: null,
                  },
                },
                atDate,
              ],
            },
          },
        ],
      }),
    );
  }

  async accessKeyInsert(record: AccessKeyRecord): Promise<void> {
    await insertUnique(this.accessKeys, AccessKeyRecordSchema, record);
  }

  async accessKeyRevoke(id: string, revokedAt: string): Promise<boolean> {
    const validatedAt = TimestampSchema.parse(revokedAt);
    const result = await this.accessKeys.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt: validatedAt } },
    );
    return result.modifiedCount === 1;
  }

  async accessKeyMarkUsed(id: string, usedAt: string): Promise<void> {
    const validatedAt = TimestampSchema.parse(usedAt);
    await this.accessKeys.updateOne(
      { _id: id, revokedAt: null },
      { $set: { lastUsedAt: validatedAt } },
    );
  }

  async sessionFindActiveById(
    id: string,
    at: string,
  ): Promise<SessionRecord | null> {
    const atDate = new Date(TimestampSchema.parse(at));
    return decode(
      SessionRecordSchema,
      await this.sessions.findOne({
        _id: id,
        revokedAt: null,
        $expr: {
          $gt: [
            { $dateFromString: { dateString: "$expiresAt", onError: null } },
            atDate,
          ],
        },
      }),
    );
  }

  async sessionInsert(record: SessionRecord): Promise<void> {
    await insertUnique(this.sessions, SessionRecordSchema, record);
  }

  async sessionRevoke(id: string, revokedAt: string): Promise<boolean> {
    const validatedAt = TimestampSchema.parse(revokedAt);
    const result = await this.sessions.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt: validatedAt } },
    );
    return result.modifiedCount === 1;
  }

  private async ownsCase(scope: OwnerScope): Promise<boolean> {
    return (
      (await this.cases.countDocuments({
        _id: scope.caseId,
        ownerId: scope.ownerId,
        isSample: false,
        status: { $ne: "deleted" },
      })) === 1
    );
  }

  private async requireOwnedCase(scope: OwnerScope): Promise<void> {
    if (!(await this.ownsCase(scope))) throw new CaseNotOwnedError();
  }

  async documentFindOwned(
    id: string,
    scope: OwnerScope,
  ): Promise<DocumentMetadataRecord | null> {
    if (!(await this.ownsCase(scope))) return null;
    return decode(
      DocumentMetadataRecordSchema,
      await this.documents.findOne({
        _id: id,
        caseId: scope.caseId,
        ownerId: scope.ownerId,
      }),
    );
  }

  async documentListOwned(scope: OwnerScope): Promise<DocumentMetadataDto[]> {
    if (!(await this.ownsCase(scope))) return [];
    const records = await this.documents
      .find({ caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ uploadedAt: 1, id: 1 })
      .toArray();
    return records.map((record) =>
      DocumentMetadataDtoSchema.parse(
        decode(DocumentMetadataRecordSchema, record),
      ),
    );
  }

  async documentInsert(
    record: DocumentMetadataRecord,
    scope: OwnerScope,
  ): Promise<void> {
    const parsed = DocumentMetadataRecordSchema.parse(record);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    const scoped = {
      ...parsed,
      ownerId: scope.ownerId,
    } as DocumentMetadataRecord & Document;
    await insertUnique(this.documents, DocumentMetadataRecordSchema, scoped);
  }

  async documentReplaceOwned(
    record: DocumentMetadataRecord,
    scope: OwnerScope,
    expectedSource?: ExpectedDocumentSource,
    claim?: Omit<ExtractionClaimRequest, "expiresAt">,
  ): Promise<boolean> {
    const parsed = DocumentMetadataRecordSchema.parse(record);
    if (parsed.caseId !== scope.caseId || !(await this.ownsCase(scope))) {
      return false;
    }
    const replace = async (session?: ClientSession): Promise<boolean> => {
      if (claim) {
        if (claim.documentId !== parsed.id) return false;
        const at = new Date(TimestampSchema.parse(claim.at));
        const owned = await this.extractionClaims.updateOne(
          {
            _id: extractionCacheId(claim),
            caseId: scope.caseId,
            ownerId: scope.ownerId,
            holderId: claim.holderId,
            expiresAt: { $gt: at },
          },
          { $set: { committedAt: at } },
          { session },
        );
        if (owned.matchedCount === 0) return false;
      }
      const result = await this.documents.replaceOne(
        {
          _id: parsed.id,
          caseId: scope.caseId,
          ownerId: scope.ownerId,
          ...(expectedSource
            ? {
                objectKey: expectedSource.objectKey,
                contentHash: expectedSource.contentHash,
                ...(expectedSource.state !== undefined
                  ? { state: expectedSource.state }
                  : {}),
                ...(expectedSource.processedAt !== undefined
                  ? { processedAt: expectedSource.processedAt }
                  : {}),
                ...(expectedSource.name !== undefined
                  ? { name: expectedSource.name }
                  : {}),
                ...(expectedSource.mimeType !== undefined
                  ? { mimeType: expectedSource.mimeType }
                  : {}),
              }
            : {}),
        },
        { ...documentFor(parsed), ownerId: scope.ownerId },
        { session },
      );
      return result.matchedCount === 1;
    };
    return claim ? this.withTransaction(replace) : replace();
  }

  async extractionFindForDocument(
    documentId: string,
    scope: OwnerScope,
  ): Promise<ExtractedDocument | null> {
    if (!(await this.ownsCase(scope))) return null;
    const record = await this.extractions.findOne(
      { documentId, caseId: scope.caseId },
      { sort: { revision: -1 } },
    );
    return decode(ExtractedDocumentSchema, record);
  }

  async extractionSaveForDocument(
    extraction: ExtractedDocument,
    scope: OwnerScope,
    claim?: { document: DocumentMetadataRecord; holderId: string; at: string },
  ): Promise<boolean> {
    const parsed = ExtractedDocumentSchema.parse(extraction);
    await this.requireOwnedCase(scope);
    const document = await this.documents.findOne({
      _id: parsed.documentId,
      caseId: scope.caseId,
      ownerId: scope.ownerId,
    });
    if (!document) {
      throw new StoreError(
        "Document does not belong to this case",
        "document-not-owned",
      );
    }
    const cacheId = extractionCacheId(parsed);
    const counterId = JSON.stringify([scope.caseId, parsed.documentId]);
    // The counter update and replacement share one transaction so a delayed
    // save cannot overwrite a newer revision with an older one.
    return this.withTransaction(async (session) => {
      if (claim) {
        const next = DocumentMetadataRecordSchema.parse(claim.document);
        const at = new Date(TimestampSchema.parse(claim.at));
        if (next.id !== parsed.documentId || next.caseId !== scope.caseId) {
          throw new StoreError(
            "Document does not belong to this case",
            "document-not-owned",
          );
        }
        // Writing the claim fences this transaction against renewal/takeover.
        const owned = await this.extractionClaims.updateOne(
          {
            _id: cacheId,
            caseId: scope.caseId,
            ownerId: scope.ownerId,
            holderId: claim.holderId,
            expiresAt: { $gt: at },
          },
          { $set: { committedAt: at } },
          { session },
        );
        if (owned.matchedCount === 0) return false;
        const updated = await this.documents.replaceOne(
          {
            _id: next.id,
            caseId: scope.caseId,
            ownerId: scope.ownerId,
            objectKey: next.objectKey,
            contentHash: next.contentHash,
            name: next.name,
            mimeType: next.mimeType,
          },
          { ...documentFor(next), ownerId: scope.ownerId },
          { session },
        );
        if (updated.matchedCount === 0) return false;
      }
      const counter = await this.extractionCounters.findOneAndUpdate(
        { _id: counterId },
        {
          $inc: { revision: 1 },
          $setOnInsert: { id: counterId },
        },
        { upsert: true, returnDocument: "after", session },
      );
      if (!counter) {
        throw new StoreError(
          "Could not assign extraction revision",
          "extraction-revision-failed",
        );
      }
      await this.extractions.replaceOne(
        { _id: cacheId },
        {
          ...documentFor({ ...parsed, id: cacheId }),
          documentId: parsed.documentId,
          caseId: scope.caseId,
          cachedAt: new Date().toISOString(),
          revision: counter.revision,
        },
        { upsert: true, session },
      );
      return true;
    });
  }

  async extractionFindCached(
    documentId: string,
    cacheIdentity: ExtractionCacheIdentity,
    scope: OwnerScope,
  ): Promise<ExtractedDocument | null> {
    if (!(await this.ownsCase(scope))) return null;
    const record = await this.extractions.findOne({
      _id: extractionCacheId({ documentId, cacheIdentity }),
      caseId: scope.caseId,
    });
    if (!record) return null;
    return decode(ExtractedDocumentSchema, record);
  }

  async extractionClaim(
    request: ExtractionClaimRequest,
    scope: OwnerScope,
  ): Promise<boolean> {
    const at = new Date(TimestampSchema.parse(request.at));
    const expiresAt = new Date(TimestampSchema.parse(request.expiresAt));
    if (expiresAt.getTime() <= at.getTime()) {
      throw new StoreError(
        "Extraction claim expiry must be after the claim time",
        "invalid-extraction-claim",
      );
    }
    await this.requireOwnedCase(scope);
    const document = await this.documents.findOne({
      _id: request.documentId,
      caseId: scope.caseId,
      ownerId: scope.ownerId,
    });
    if (!document) {
      throw new StoreError(
        "Document does not belong to this case",
        "document-not-owned",
      );
    }
    const claimId = extractionCacheId(request);
    try {
      // Matching only our own or expired claims makes a live foreign claim
      // fall through to the upsert, which then fails on the unique _id.
      await this.extractionClaims.updateOne(
        {
          _id: claimId,
          $or: [{ holderId: request.holderId }, { expiresAt: { $lte: at } }],
        },
        {
          $set: {
            documentId: request.documentId,
            caseId: scope.caseId,
            ownerId: scope.ownerId,
            holderId: request.holderId,
            claimedAt: at,
            expiresAt,
          },
        },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  async extractionRenewClaim(
    request: ExtractionClaimRequest,
    scope: OwnerScope,
    options?: { recoverExpired?: boolean },
  ): Promise<boolean> {
    await this.requireOwnedCase(scope);
    const at = new Date(TimestampSchema.parse(request.at));
    const expiresAt = new Date(TimestampSchema.parse(request.expiresAt));
    if (expiresAt.getTime() <= at.getTime()) {
      throw new StoreError(
        "Extraction claim expiry must be after the claim time",
        "invalid-extraction-claim",
      );
    }
    const result = await this.extractionClaims.updateOne(
      {
        _id: extractionCacheId(request),
        caseId: scope.caseId,
        ownerId: scope.ownerId,
        holderId: request.holderId,
        ...(options?.recoverExpired ? {} : { expiresAt: { $gt: at } }),
      },
      { $set: { expiresAt } },
    );
    return result.matchedCount === 1;
  }

  async extractionReleaseClaim(
    request: Omit<ExtractionClaimRequest, "at" | "expiresAt">,
    scope: OwnerScope,
  ): Promise<void> {
    await this.extractionClaims.deleteOne({
      _id: extractionCacheId(request),
      caseId: scope.caseId,
      ownerId: scope.ownerId,
      holderId: request.holderId,
    });
  }

  async extractionDeleteForCase(scope: OwnerScope): Promise<number> {
    const owned = await this.cases.countDocuments({
      _id: scope.caseId,
      ownerId: scope.ownerId,
      isSample: false,
    });
    if (owned !== 1) throw new CaseNotOwnedError();
    return this.withTransaction(async (session) => {
      const documentIds = await this.extractions.distinct(
        "documentId",
        { caseId: scope.caseId },
        { session },
      );
      const result = await this.extractions.deleteMany(
        { caseId: scope.caseId },
        { session },
      );
      await this.extractionClaims.deleteMany(
        { caseId: scope.caseId },
        { session },
      );
      await this.extractionCounters.deleteMany(
        {
          _id: {
            $in: documentIds.map((documentId) =>
              JSON.stringify([scope.caseId, documentId]),
            ),
          },
        },
        { session },
      );
      return result.deletedCount;
    });
  }

  async evidenceListForCase(scope: OwnerScope): Promise<Evidence[]> {
    if (!(await this.ownsCase(scope))) return [];
    const records = await this.evidence
      .find({ caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ id: 1 })
      .toArray();
    return records.map((record) => decode(EvidenceSchema, record)!);
  }

  async evidenceInsert(evidence: Evidence, scope: OwnerScope): Promise<void> {
    const parsed = EvidenceSchema.parse(evidence);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    const record = { ...parsed, ownerId: scope.ownerId };
    await insertUnique(this.evidence, EvidenceSchema, record);
  }

  async findingListForCase(scope: OwnerScope): Promise<Finding[]> {
    if (!(await this.ownsCase(scope))) return [];
    const records = await this.findings
      .find({ caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ createdAt: 1, id: 1 })
      .toArray();
    return records.map((record) => decode(FindingSchema, record)!);
  }

  async findingInsert(finding: Finding, scope: OwnerScope): Promise<void> {
    const parsed = FindingSchema.parse(finding);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    await insertUnique(this.findings, FindingSchema, {
      ...parsed,
      ownerId: scope.ownerId,
    });
  }

  async taskListForRun(runId: string, scope: OwnerScope): Promise<Task[]> {
    if (!(await this.ownsCase(scope))) return [];
    const run = await this.runs.findOne({
      _id: runId,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
    });
    if (!run) return [];
    const records = await this.tasks
      .find({ runId, caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ id: 1 })
      .toArray();
    return records.map((record) => decode(TaskSchema, record)!);
  }

  async taskInsert(task: Task, scope: OwnerScope): Promise<void> {
    const parsed = TaskSchema.parse(task);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    const run = await this.runs.findOne({
      _id: parsed.runId,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
    });
    if (!run) {
      throw new StoreError("Run does not belong to this case", "run-not-owned");
    }
    await insertUnique(this.tasks, TaskSchema, {
      ...parsed,
      ownerId: scope.ownerId,
    });
  }

  async taskReplaceOwned(
    task: Task,
    scope: OwnerScope,
    options?: { fencingToken: number },
    output?: {
      evidence: Evidence[];
      findings: Finding[];
      deliverable?: Deliverable;
    },
  ): Promise<boolean> {
    const parsed = TaskSchema.parse(task);
    if (parsed.caseId !== scope.caseId || !(await this.ownsCase(scope))) {
      return false;
    }
    return this.withTransaction(async (session) => {
      const run = await this.runs.findOne(
        {
          _id: parsed.runId,
          ownerId: scope.ownerId,
          caseId: scope.caseId,
          ...(options ? { fencingToken: options.fencingToken } : {}),
        },
        { session },
      );
      if (!run) return false;
      if (options) {
        // Touch the fenced run so a concurrent lease change conflicts with
        // this transaction instead of letting a stale worker commit.
        await this.runs.updateOne(
          { _id: parsed.runId, fencingToken: options.fencingToken },
          { $inc: { taskWrites: 1 } },
          { session },
        );
      }
      const result = await this.tasks.replaceOne(
        {
          _id: parsed.id,
          runId: parsed.runId,
          caseId: scope.caseId,
          ownerId: scope.ownerId,
        },
        { ...documentFor(parsed), ownerId: scope.ownerId },
        { session },
      );
      if (result.matchedCount !== 1) return false;
      if (output) {
        const deliverable = output.deliverable
          ? DeliverableSchema.parse(output.deliverable)
          : undefined;
        const evidence = output.evidence.map((item) =>
          EvidenceSchema.parse(item),
        );
        const findings = output.findings.map((item) =>
          FindingSchema.parse(item),
        );
        if (
          (deliverable &&
            (deliverable.caseId !== scope.caseId ||
              deliverable.runId !== parsed.runId)) ||
          [...evidence, ...findings].some(
            (item) => item.caseId !== scope.caseId,
          )
        )
          throw new CaseNotOwnedError();
        for (const item of evidence) {
          await this.evidence.updateOne(
            { _id: item.id, caseId: scope.caseId, ownerId: scope.ownerId },
            { $setOnInsert: { ...documentFor(item), ownerId: scope.ownerId } },
            { upsert: true, session },
          );
        }
        for (const item of findings) {
          await this.findings.updateOne(
            { _id: item.id, caseId: scope.caseId, ownerId: scope.ownerId },
            { $setOnInsert: { ...documentFor(item), ownerId: scope.ownerId } },
            { upsert: true, session },
          );
        }
        if (deliverable) {
          const existing = decode(
            DeliverableSchema,
            await this.deliverables.findOne(
              {
                _id: deliverable.id,
                caseId: scope.caseId,
                ownerId: scope.ownerId,
                runId: parsed.runId,
              },
              { session },
            ),
          );
          const merged = existing
            ? {
                ...existing,
                summary: deliverable.summary || existing.summary,
                sections: [
                  ...existing.sections,
                  ...deliverable.sections.filter(
                    (section) =>
                      !existing.sections.some(
                        (prior) => prior.id === section.id,
                      ),
                  ),
                ],
                updatedAt: deliverable.updatedAt,
              }
            : deliverable;
          await this.deliverables.replaceOne(
            {
              _id: deliverable.id,
              caseId: scope.caseId,
              ownerId: scope.ownerId,
              runId: parsed.runId,
            },
            { ...documentFor(merged), ownerId: scope.ownerId },
            { upsert: true, session },
          );
        }
      }
      return result.matchedCount === 1;
    });
  }

  async taskInsertPlan(
    tasks: Task[],
    scope: OwnerScope,
    options: { fencingToken: number },
  ): Promise<void> {
    await this.requireOwnedCase(scope);
    await this.withTransaction(async (session) => {
      const run =
        tasks[0] &&
        (await this.runs.findOneAndUpdate(
          {
            _id: tasks[0].runId,
            ownerId: scope.ownerId,
            caseId: scope.caseId,
            fencingToken: options.fencingToken,
          },
          { $inc: { taskWrites: 1 } },
          { session, returnDocument: "after" },
        ));
      if (!run)
        throw new StoreError(
          "Run lease generation is stale",
          "stale-fencing-token",
        );
      const plan = TaskPlanSchema.parse({
        caseId: scope.caseId,
        runId: run.id,
        version: run.planVersion,
        tasks,
      });
      await this.tasks.insertMany(
        plan.tasks.map((task) => ({
          ...documentFor(task),
          ownerId: scope.ownerId,
        })),
        { session },
      );
    });
  }

  async runListClaimable(
    at: string,
    limit = 50,
    after?: Pick<RunRecord, "createdAt" | "id">,
  ): Promise<RunRecord[]> {
    const atMs = Date.parse(TimestampSchema.parse(at));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new StoreError("Invalid run query limit", "invalid-query-limit");
    const records = await this.runs
      .aggregate([
        {
          $match: {
            $or: [
              { "terminalEvent.pending": true },
              { status: "waiting-for-input", cancellationRequested: true },
              {
                status: { $in: ["queued", "running"] },
                $expr: {
                  $or: [
                    { $eq: ["$leaseExpiresAt", null] },
                    {
                      $lte: [
                        { $dateFromString: { dateString: "$leaseExpiresAt" } },
                        new Date(atMs),
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          $addFields: {
            createdAtInstant: { $dateFromString: { dateString: "$createdAt" } },
          },
        },
        ...(after
          ? [
              {
                $match: {
                  $or: [
                    {
                      createdAtInstant: {
                        $gt: new Date(TimestampSchema.parse(after.createdAt)),
                      },
                    },
                    {
                      createdAtInstant: new Date(after.createdAt),
                      _id: { $gt: after.id },
                    },
                  ],
                },
              },
            ]
          : []),
        { $sort: { createdAtInstant: 1, _id: 1 } },
        { $limit: limit },
        { $unset: "createdAtInstant" },
      ])
      .toArray();
    return records.map((record) => decode(RunRecordSchema, record)!);
  }

  async runFindOwnedById(
    id: string,
    ownerId: string,
  ): Promise<RunRecord | null> {
    return decode(
      RunRecordSchema,
      await this.runs.findOne({ _id: id, ownerId }),
    );
  }

  async runListForCase(caseId: string, ownerId: string): Promise<RunRecord[]> {
    const records = await this.runs
      .find({ caseId, ownerId })
      .sort({ createdAt: -1, id: -1 })
      .toArray();
    return records.map((record) => decode(RunRecordSchema, record)!);
  }

  async runInsert(run: RunRecord, tasks?: Task[]): Promise<void> {
    const parsed = RunRecordSchema.parse(run);
    const parent = await this.cases.findOne({
      _id: parsed.caseId,
      ownerId: parsed.ownerId,
      isSample: false,
      status: { $ne: "deleted" },
    });
    if (!parent) throw new CaseNotOwnedError();
    const active = ["queued", "running", "waiting-for-input"].includes(
      parsed.status,
    )
      ? { activeCaseKey: activeCaseKey(parsed.ownerId, parsed.caseId) }
      : {};
    if (tasks) {
      const plan = TaskPlanSchema.parse({
        caseId: parsed.caseId,
        runId: parsed.id,
        version: parsed.planVersion,
        tasks,
      });
      try {
        await this.withTransaction(async (session) => {
          await this.runs.insertOne(
            { ...documentFor(parsed), ...active },
            { session },
          );
          if (plan.tasks.length)
            await this.tasks.insertMany(
              plan.tasks.map((task) => ({
                ...documentFor(task),
                ownerId: parsed.ownerId,
              })),
              { session },
            );
        });
      } catch (error) {
        if (isDuplicateKey(error))
          throw new StoreError(
            "Run or task already exists",
            "duplicate-record",
            { cause: error },
          );
        throw error;
      }
      return;
    }
    await insertUnique(this.runs, RunRecordSchema, {
      ...parsed,
      ...active,
    } as RunRecord);
  }

  async runUpdateOwned(run: RunRecord, ownerId: string): Promise<boolean> {
    const parsed = RunRecordSchema.parse(run);
    if (parsed.ownerId !== ownerId) return false;
    const active = ["queued", "running", "waiting-for-input"].includes(
      parsed.status,
    )
      ? { activeCaseKey: activeCaseKey(parsed.ownerId, parsed.caseId) }
      : {};
    try {
      const result = await this.runs.replaceOne(
        {
          _id: parsed.id,
          ownerId,
          caseId: parsed.caseId,
          fencingToken: parsed.fencingToken,
          // Lease and admission transitions belong to the admission API, and
          // a renewed lease must not be overwritten by an older snapshot.
          leaseId: parsed.leaseId,
          leaseExpiresAt: parsed.leaseExpiresAt,
          ...(parsed.cancellationRequested
            ? {}
            : { cancellationRequested: false }),
          ...(parsed.leaseId !== null || parsed.status === "waiting-for-input"
            ? {
                status: parsed.status,
                ...(parsed.status === "waiting-for-input"
                  ? { inputRequired: parsed.inputRequired }
                  : {}),
              }
            : { status: { $ne: "waiting-for-input" as const } }),
        },
        { ...documentFor(parsed), ...active },
      );
      return result.matchedCount === 1;
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new StoreError(
          "An active run already exists for this case",
          "duplicate-record",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async acquireRunLease(request: MongoRunLease): Promise<RunRecord | null> {
    const parsedRequest = MongoRunLeaseSchema.parse(request);
    const at = new Date(Date.parse(parsedRequest.at)).toISOString();
    const expiresAt = new Date(
      Date.parse(parsedRequest.expiresAt),
    ).toISOString();
    return this.withTransaction(async (session) => {
      const current = decode(
        RunRecordSchema,
        await this.runs.findOne(
          {
            _id: parsedRequest.runId,
            ownerId: parsedRequest.ownerId,
            status: "running",
            $or: [
              { leaseExpiresAt: null },
              {
                $expr: {
                  $lte: [{ $toDate: "$leaseExpiresAt" }, new Date(at)],
                },
              },
            ],
          },
          { session },
        ),
      );
      if (!current) return null;
      const activeAdmission = await this.runAdmissions.findOne(
        {
          runId: current.id,
          ownerId: current.ownerId,
          caseId: current.caseId,
          state: "active",
        },
        { session },
      );
      if (!activeAdmission) return null;
      if (
        activeAdmission.fencingToken !== current.fencingToken ||
        activeAdmission.leaseId !== current.leaseId ||
        typeof activeAdmission.leaseExpiresAt !== "string" ||
        Date.parse(activeAdmission.leaseExpiresAt) <= Date.parse(at)
      ) {
        return null;
      }
      const fencingToken = current.fencingToken + 1;
      const update = await this.runs.updateOne(
        {
          _id: current.id,
          ownerId: current.ownerId,
          caseId: current.caseId,
          fencingToken: current.fencingToken,
          status: "running",
          leaseId: current.leaseId,
          leaseExpiresAt: current.leaseExpiresAt,
          cancellationRequested: false,
        },
        {
          $set: {
            leaseId: parsedRequest.leaseId,
            leaseExpiresAt: expiresAt,
            fencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (update.matchedCount !== 1) return null;
      const admissionUpdate = await this.runAdmissions.updateOne(
        {
          _id: activeAdmission._id,
          state: "active",
          fencingToken: current.fencingToken,
          leaseId: current.leaseId,
          leaseExpiresAt: activeAdmission.leaseExpiresAt,
        },
        {
          $set: {
            leaseId: parsedRequest.leaseId,
            leaseExpiresAt: expiresAt,
            fencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (admissionUpdate.matchedCount !== 1) {
        throw new StoreError(
          "Run admission changed during lease acquisition",
          "stale-run-admission",
        );
      }

      return decode(
        RunRecordSchema,
        await this.runs.findOne({ _id: current.id }, { session }),
      );
    });
  }

  async deliverableFindOwnedById(
    id: string,
    scope: OwnerScope,
  ): Promise<Deliverable | null> {
    if (!(await this.ownsCase(scope))) return null;
    return decode(
      DeliverableSchema,
      await this.deliverables.findOne({
        _id: id,
        caseId: scope.caseId,
        ownerId: scope.ownerId,
      }),
    );
  }

  async deliverableListForRun(
    runId: string,
    scope: OwnerScope,
  ): Promise<Deliverable[]> {
    if (!(await this.ownsCase(scope))) return [];
    const run = await this.runs.findOne({
      _id: runId,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
    });
    if (!run) return [];
    const records = await this.deliverables
      .find({ runId, caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ version: -1, id: 1 })
      .toArray();
    return records.map((record) => decode(DeliverableSchema, record)!);
  }

  async deliverableInsert(
    deliverable: Deliverable,
    scope: OwnerScope,
  ): Promise<void> {
    const parsed = DeliverableSchema.parse(deliverable);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    const run = await this.runs.findOne({
      _id: parsed.runId,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
    });
    if (!run)
      throw new StoreError("Run does not belong to this case", "run-not-owned");
    await insertUnique(this.deliverables, DeliverableSchema, {
      ...parsed,
      ownerId: scope.ownerId,
    });
  }

  async deliverableReplaceOwned(
    deliverable: Deliverable,
    scope: OwnerScope,
  ): Promise<boolean> {
    const parsed = DeliverableSchema.parse(deliverable);
    if (parsed.caseId !== scope.caseId || !(await this.ownsCase(scope))) {
      return false;
    }
    return this.withTransaction(async (session) => {
      const previous = await this.deliverables.findOne(
        { _id: parsed.id, caseId: scope.caseId, ownerId: scope.ownerId },
        { session },
      );
      if (!previous) return false;
      const run = await this.runs.findOne(
        {
          _id: parsed.runId,
          ownerId: scope.ownerId,
          caseId: scope.caseId,
        },
        { session },
      );
      if (!run) {
        throw new StoreError(
          "Run does not belong to this case",
          "run-not-owned",
        );
      }
      const result = await this.deliverables.replaceOne(
        { _id: parsed.id, caseId: scope.caseId, ownerId: scope.ownerId },
        { ...documentFor(parsed), ownerId: scope.ownerId },
        { session },
      );
      if (result.matchedCount !== 1) return false;
      if (previous.version !== parsed.version) {
        await this.approvals.deleteMany(
          {
            deliverableId: parsed.id,
            caseId: scope.caseId,
            ownerId: scope.ownerId,
          },
          { session },
        );
      }
      return true;
    });
  }

  async approvalFindForDeliverable(
    deliverableId: string,
    scope: OwnerScope,
  ): Promise<Approval | null> {
    if (!(await this.ownsCase(scope))) return null;
    return decode(
      ApprovalSchema,
      await this.approvals.findOne({
        deliverableId,
        caseId: scope.caseId,
        ownerId: scope.ownerId,
      }),
    );
  }

  async approvalInsert(approval: Approval, scope: OwnerScope): Promise<void> {
    const parsed = ApprovalSchema.parse(approval);
    if (parsed.caseId !== scope.caseId) throw new CaseNotOwnedError();
    await this.requireOwnedCase(scope);
    await this.withTransaction(async (session) => {
      const result = await this.deliverables.updateOne(
        {
          _id: parsed.deliverableId,
          caseId: scope.caseId,
          ownerId: scope.ownerId,
          version: parsed.deliverableVersion,
        },
        { $inc: { approvalRevision: 1 } },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new StoreError(
          "Deliverable version is not current",
          "stale-approval",
        );
      }
      await insertUnique(
        this.approvals,
        ApprovalSchema,
        { ...parsed, ownerId: scope.ownerId },
        session,
      );
    });
  }

  async approvalInvalidateForDeliverable(
    deliverableId: string,
    scope: OwnerScope,
  ): Promise<void> {
    if (!(await this.ownsCase(scope))) return;
    await this.approvals.deleteMany({
      deliverableId,
      caseId: scope.caseId,
      ownerId: scope.ownerId,
    });
  }

  async eventAppend(
    event: RunEvent,
    scope: OwnerScope,
    options?: { fencingToken: number },
  ): Promise<void> {
    const parsed = RunEventSchema.parse(event);
    if (parsed.caseId !== scope.caseId || !(await this.ownsCase(scope))) {
      throw new CaseNotOwnedError();
    }
    const run = await this.runs.findOne({
      _id: parsed.runId,
      caseId: parsed.caseId,
      ownerId: scope.ownerId,
    });
    if (!run) {
      throw new StoreError("Run does not belong to this case", "run-not-found");
    }
    await this.withTransaction(async (session) => {
      if (options) {
        // A conditional write to the run conflicts with a concurrent lease
        // acquisition, so a stale worker cannot publish after reclamation.
        const fenced = await this.runs.updateOne(
          {
            _id: parsed.runId,
            caseId: parsed.caseId,
            ownerId: scope.ownerId,
            fencingToken: options.fencingToken,
          },
          { $inc: { eventWrites: 1 } },
          { session },
        );
        if (fenced.matchedCount !== 1) {
          throw new StoreError(
            "Run lease generation is stale",
            "stale-fencing-token",
          );
        }
      }
      const current = await this.eventCounters.findOne(
        { _id: parsed.caseId },
        { session },
      );
      if (current && parsed.sequence <= current.sequence) {
        throw new SequenceConflictError();
      }
      if (current) {
        const result = await this.eventCounters.updateOne(
          { _id: parsed.caseId, sequence: current.sequence },
          { $set: { sequence: parsed.sequence } },
          { session },
        );
        if (result.modifiedCount !== 1) throw new SequenceConflictError();
      } else {
        await this.eventCounters.insertOne(
          documentFor({ id: parsed.caseId, sequence: parsed.sequence }),
          { session },
        );
      }
      await insertUnique(this.events, RunEventSchema, parsed, session);
    });
  }

  async eventListAfter(
    caseId: string,
    afterSequence: number,
    scope: OwnerScope,
  ): Promise<RunEvent[]> {
    if (caseId !== scope.caseId || !(await this.ownsCase(scope))) return [];
    const records = await this.events
      .find({ caseId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .toArray();
    return records.map((record) => decode(RunEventSchema, record)!);
  }

  async usageListForRun(
    runId: string,
    scope: OwnerScope,
  ): Promise<UsageRecord[]> {
    if (!(await this.ownsCase(scope))) return [];
    const records = await this.usageAttempts
      .find({ runId, caseId: scope.caseId, ownerId: scope.ownerId })
      .sort({ recordedAt: 1, id: 1 })
      .toArray();
    const ledger = await this.usageAccounting.listForRun(
      scope.ownerId,
      scope.caseId,
      runId,
    );
    const ledgerAttempts = new Set(ledger.map((entry) => entry.attemptId));
    return [
      ...records
        .map((record) => decode(UsageRecordSchema, record)!)
        .filter((record) => !ledgerAttempts.has(record.attemptId)),
      ...ledger.map((entry) =>
        UsageRecordSchema.parse({
          id: entry.id,
          attemptId: entry.attemptId,
          provider: entry.provider,
          model: entry.model,
          settings: entry.settings,
          units: entry.units,
          costUsd: entry.costUsd,
          costStatus: entry.costStatus,
          recordedAt: entry.settledAt ?? entry.createdAt,
        }),
      ),
    ].sort(
      (left, right) =>
        Date.parse(left.recordedAt) - Date.parse(right.recordedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  private async backfillActiveRunKeys(): Promise<void> {
    const conflicts = await this.runs
      .aggregate<{ _id: { ownerId: string; caseId: string }; count: number }>([
        {
          $match: {
            status: { $in: ["queued", "running", "waiting-for-input"] },
          },
        },
        {
          $group: {
            _id: { ownerId: "$ownerId", caseId: "$caseId" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ])
      .toArray();
    if (conflicts.length > 0) {
      throw new StoreError(
        "Cannot initialize active-run uniqueness: existing cases have conflicting active runs",
        "active-run-migration-conflict",
      );
    }

    const cursor = this.runs.find({
      status: { $in: ["queued", "running", "waiting-for-input"] },
    });
    for await (const run of cursor) {
      const activeKey = activeCaseKey(run.ownerId, run.caseId);
      if (run.activeCaseKey === activeKey) continue;
      await this.runs.updateOne(
        {
          _id: run._id,
          status: { $in: ["queued", "running", "waiting-for-input"] },
        },
        { $set: { activeCaseKey: activeKey } },
      );
    }
  }

  async usageInsert(
    usage: UsageRecord,
    runId: string,
    scope: OwnerScope,
  ): Promise<void> {
    const parsed = UsageRecordSchema.parse(usage);
    await this.requireOwnedCase(scope);
    const run = await this.runs.findOne({
      _id: runId,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
    });
    if (!run)
      throw new StoreError("Run does not belong to this case", "run-not-owned");
    await insertUnique(this.usageAttempts, UsageRecordSchema, {
      ...parsed,
      ownerId: scope.ownerId,
      caseId: scope.caseId,
      runId,
    });
  }
}

export async function connectMongoStore(
  config: MongoConfig = getMongoConfig(),
): Promise<MongoStore> {
  const client = new (await import("mongodb")).MongoClient(config.uri);
  await client.connect();
  const store = new MongoStore({ client, db: client.db(config.dbName) });
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await client.close();
    throw error;
  }
}
