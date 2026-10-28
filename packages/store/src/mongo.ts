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
  UserRecordSchema,
  UsageRecordSchema,
  type AccessKeyRecord,
  type AgentProfile,
  type Approval,
  type Case,
  type Deliverable,
  type DocumentMetadataDto,
  type DocumentMetadataRecord,
  type Evidence,
  type ExtractedDocument,
  type Finding,
  type OwnerScope,
  type RunEvent,
  type RunRecord,
  type SessionRecord,
  type Task,
  type UserRecord,
  type UsageRecord,
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
  type SessionRepository,
  type TaskRepository,
  type UserRepository,
  type UsageRepository,
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
import {
  getMongoDatabaseName as parseMongoDatabaseName,
  getMongoDbUri,
} from "@evianta/env/server";
import { z, type ZodType } from "zod";

type Stored<T> = T & Document & { _id: string };
const MongoUriSchema = z.string().superRefine((uri, context) => {
  try {
    parseMongoDatabaseName(uri);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid MongoDB URI",
    });
  }
});

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CaseNotOwnedError extends StoreError {
  constructor() {
    super(
      "The case does not exist in the requested owner scope",
      "case-not-owned",
    );
  }
}

export class InvalidCursorError extends StoreError {
  constructor() {
    super("The case pagination cursor is invalid", "invalid-cursor");
  }
}

export class SequenceConflictError extends StoreError {
  constructor() {
    super(
      "Run event sequence must increase monotonically for its case",
      "event-sequence-conflict",
    );
  }
}

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

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
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
  readonly agents: Collection<Stored<AgentProfile>>;
  readonly users: Collection<Stored<UserRecord>>;
  readonly accessKeys: Collection<Stored<AccessKeyRecord>>;
  readonly sessions: Collection<Stored<SessionRecord>>;
  readonly cases: Collection<Stored<Case>>;
  readonly documents: Collection<Stored<DocumentMetadataRecord>>;
  readonly extractions: Collection<
    Stored<ExtractedDocument> & { caseId: string; cachedAt: string }
  >;
  readonly tasks: Collection<Stored<Task>>;
  readonly findings: Collection<Stored<Finding>>;
  readonly evidence: Collection<Stored<Evidence>>;
  readonly deliverables: Collection<
    Stored<Deliverable> & { approvalRevision?: number }
  >;
  readonly approvals: Collection<Stored<Approval>>;
  readonly runs: Collection<Stored<RunRecord> & { activeCaseKey?: string }>;
  readonly events: Collection<Stored<RunEvent>>;
  readonly eventCounters: Collection<Stored<{ id: string; sequence: number }>>;
  readonly usageAttempts: Collection<Stored<UsageRecord>>;
  readonly reservations: Collection<
    Stored<UsageReservation> & { idempotencyKey: string }
  >;
  readonly budgets: Collection<Document>;
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
  };

  constructor(private readonly options: MongoStoreOptions) {
    const { db } = options;
    this.pageSize = options.pageSize ?? 50;
    this.agents = db.collection("agents");
    this.users = db.collection("users");
    this.accessKeys = db.collection("accessKeys");
    this.sessions = db.collection("sessions");
    this.cases = db.collection("cases");
    this.documents = db.collection("documents");
    this.extractions = db.collection("extractions");
    this.tasks = db.collection("tasks");
    this.findings = db.collection("findings");
    this.evidence = db.collection("evidence");
    this.deliverables = db.collection("deliverables");
    this.approvals = db.collection("approvals");
    this.runs = db.collection("runs");
    this.events = db.collection("events");
    this.eventCounters = db.collection("eventCounters");
    this.usageAttempts = db.collection("usageAttempts");
    this.reservations = db.collection("usageReservations");
    this.budgets = db.collection("budgets");
    this.repositories = {
      agentProfiles: {
        listEnabled: () => this.agentListEnabled(),
        findByRole: (role) => this.agentFindByRole(role),
        upsert: (profile) => this.agentUpsert(profile),
      },
      cases: {
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
        findActiveById: (id) => this.accessKeyFindActiveById(id),
        insert: (record) => this.accessKeyInsert(record),
        revoke: (id, at) => this.accessKeyRevoke(id, at),
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
        replaceOwned: (record, scope) =>
          this.documentReplaceOwned(record, scope),
      },
      extractions: {
        findForDocument: (id, scope) =>
          this.extractionFindForDocument(id, scope),
        saveForDocument: (record, scope) =>
          this.extractionSaveForDocument(record, scope),
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
        listForRun: (id, scope) => this.taskListForRun(id, scope),
        insert: (record, scope) => this.taskInsert(record, scope),
      },
      runs: {
        findOwnedById: (id, ownerId) => this.runFindOwnedById(id, ownerId),
        insert: (record) => this.runInsert(record),
        updateOwned: (record, ownerId) => this.runUpdateOwned(record, ownerId),
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
        append: (record, scope) => this.eventAppend(record, scope),
        listAfter: (caseId, sequence, scope) =>
          this.eventListAfter(caseId, sequence, scope),
      },
      usage: {
        listForRun: (id, scope) => this.usageListForRun(id, scope),
        insert: (record, runId, scope) =>
          this.usageInsert(record, runId, scope),
      },
    };
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.agents.createIndex({ role: 1 }, { unique: true }),
      this.users.createIndex({ emailKey: 1 }, { unique: true }),
      this.accessKeys.createIndex({ userId: 1, revokedAt: 1 }),
      this.sessions.createIndex({ userId: 1, expiresAt: 1, revokedAt: 1 }),
      this.cases.createIndex({ ownerId: 1, createdAt: -1, id: -1 }),
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
      this.extractions.createIndex({ caseId: 1, documentId: 1, cachedAt: -1 }),
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
  }

  async close(): Promise<void> {
    await this.options.client.close();
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
    await this.agents.replaceOne({ role: parsed.role }, documentFor(parsed), {
      upsert: true,
    });
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
        { createdAt: { $lt: before.createdAt } },
        { createdAt: before.createdAt, id: { $lt: before.id } },
      ];
    }
    const records = await this.cases
      .find(query)
      .sort({ createdAt: -1, id: -1 })
      .limit(this.pageSize)
      .toArray();
    return records.map((record) => decode(CaseSchema, record)!);
  }

  async caseInsert(record: Case): Promise<void> {
    await insertUnique(this.cases, CaseSchema, record);
  }

  async caseReplaceOwned(record: Case, ownerId: string): Promise<boolean> {
    const parsed = CaseSchema.parse(record);
    if (parsed.ownerId !== ownerId || parsed.isSample) return false;
    const result = await this.cases.replaceOne(
      { _id: parsed.id, ownerId, isSample: false },
      documentFor(parsed),
    );
    return result.matchedCount === 1;
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

  async accessKeyFindActiveById(id: string): Promise<AccessKeyRecord | null> {
    return decode(
      AccessKeyRecordSchema,
      await this.accessKeys.findOne({ _id: id, revokedAt: null }),
    );
  }

  async accessKeyInsert(record: AccessKeyRecord): Promise<void> {
    await insertUnique(this.accessKeys, AccessKeyRecordSchema, record);
  }

  async accessKeyRevoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.accessKeys.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt } },
    );
    return result.modifiedCount === 1;
  }

  async sessionFindActiveById(
    id: string,
    at: string,
  ): Promise<SessionRecord | null> {
    return decode(
      SessionRecordSchema,
      await this.sessions.findOne({
        _id: id,
        revokedAt: null,
        $expr: {
          $gt: [
            { $dateFromString: { dateString: "$expiresAt", onError: null } },
            new Date(at),
          ],
        },
      }),
    );
  }

  async sessionInsert(record: SessionRecord): Promise<void> {
    await insertUnique(this.sessions, SessionRecordSchema, record);
  }

  async sessionRevoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.sessions.updateOne(
      { _id: id, revokedAt: null },
      { $set: { revokedAt } },
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
  ): Promise<boolean> {
    const parsed = DocumentMetadataRecordSchema.parse(record);
    if (parsed.caseId !== scope.caseId || !(await this.ownsCase(scope))) {
      return false;
    }
    const result = await this.documents.replaceOne(
      { _id: parsed.id, caseId: scope.caseId, ownerId: scope.ownerId },
      { ...documentFor(parsed), ownerId: scope.ownerId },
    );
    return result.matchedCount === 1;
  }

  async extractionFindForDocument(
    documentId: string,
    scope: OwnerScope,
  ): Promise<ExtractedDocument | null> {
    if (!(await this.ownsCase(scope))) return null;
    const record = await this.extractions.findOne(
      {
        _id: {
          $regex: `^${escapeRegex(encodeURIComponent(documentId))}:`,
        },
        caseId: scope.caseId,
      },
      { sort: { cachedAt: -1 } },
    );
    return decode(ExtractedDocumentSchema, record);
  }

  async extractionSaveForDocument(
    extraction: ExtractedDocument,
    scope: OwnerScope,
  ): Promise<void> {
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
    const cacheId = [
      parsed.documentId,
      parsed.cacheIdentity.contentHash,
      parsed.cacheIdentity.extractorVersion,
      parsed.cacheIdentity.modelVersion ?? "none",
    ]
      .map(encodeURIComponent)
      .join(":");
    await this.extractions.replaceOne(
      { _id: cacheId },
      {
        ...documentFor({ ...parsed, id: cacheId }),
        documentId: parsed.documentId,
        caseId: scope.caseId,
        cachedAt: new Date().toISOString(),
      },
      { upsert: true },
    );
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

  async runFindOwnedById(
    id: string,
    ownerId: string,
  ): Promise<RunRecord | null> {
    return decode(
      RunRecordSchema,
      await this.runs.findOne({ _id: id, ownerId }),
    );
  }

  async runInsert(run: RunRecord): Promise<void> {
    const parsed = RunRecordSchema.parse(run);
    const parent = await this.cases.findOne({
      _id: parsed.caseId,
      ownerId: parsed.ownerId,
      isSample: false,
      status: { $ne: "deleted" },
    });
    if (!parent) throw new CaseNotOwnedError();
    const active =
      parsed.status === "queued" || parsed.status === "running"
        ? { activeCaseKey: `${parsed.ownerId}:${parsed.caseId}` }
        : {};
    await insertUnique(this.runs, RunRecordSchema, {
      ...parsed,
      ...active,
    } as RunRecord);
  }

  async runUpdateOwned(run: RunRecord, ownerId: string): Promise<boolean> {
    const parsed = RunRecordSchema.parse(run);
    if (parsed.ownerId !== ownerId) return false;
    const active =
      parsed.status === "queued" || parsed.status === "running"
        ? { activeCaseKey: `${parsed.ownerId}:${parsed.caseId}` }
        : {};
    const result = await this.runs.replaceOne(
      {
        _id: parsed.id,
        ownerId,
        caseId: parsed.caseId,
        fencingToken: parsed.fencingToken,
      },
      { ...documentFor(parsed), ...active },
    );
    return result.matchedCount === 1;
  }

  async acquireRunLease(request: MongoRunLease): Promise<RunRecord | null> {
    const result = await this.runs.findOneAndUpdate(
      {
        _id: request.runId,
        ownerId: request.ownerId,
        status: "running",
        $or: [
          { leaseExpiresAt: null },
          {
            $expr: {
              $lte: [
                {
                  $dateFromString: {
                    dateString: "$leaseExpiresAt",
                    onError: null,
                  },
                },
                new Date(request.at),
              ],
            },
          },
        ],
      },
      {
        $set: {
          leaseId: request.leaseId,
          leaseExpiresAt: request.expiresAt,
          updatedAt: request.at,
        },
        $inc: { fencingToken: 1 },
      },
      { returnDocument: "after" },
    );
    return decode(RunRecordSchema, result);
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

  async eventAppend(event: RunEvent, scope: OwnerScope): Promise<void> {
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
    return records.map((record) => decode(UsageRecordSchema, record)!);
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getMongoDatabaseName(uri: string): string {
  return parseMongoDatabaseName(MongoUriSchema.parse(uri));
}

export async function connectMongoStore(
  uri = getMongoDbUri(),
): Promise<MongoStore> {
  const parsedUri = MongoUriSchema.parse(uri);
  const client = new (await import("mongodb")).MongoClient(parsedUri);
  await client.connect();
  const store = new MongoStore({
    client,
    db: client.db(getMongoDatabaseName(parsedUri)),
  });
  try {
    await store.initialize();
    return store;
  } catch (error) {
    await client.close();
    throw error;
  }
}
