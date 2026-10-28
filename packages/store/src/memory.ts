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
import { CaseNotOwnedError, InvalidCursorError, StoreError } from "./mongo.js";
import type { ZodType } from "zod";

type Identified = { id: string };
type DataMap<T extends Identified> = Map<string, T>;

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(structuredClone(value));
}

function duplicate(
  message = "A record with the same identity already exists",
): never {
  throw new StoreError(message, "duplicate-record");
}

export class InMemoryStore {
  private readonly profiles: DataMap<AgentProfile> = new Map();
  private readonly cases: DataMap<Case> = new Map();
  private readonly users: DataMap<UserRecord> = new Map();
  private readonly accessKeys: DataMap<AccessKeyRecord> = new Map();
  private readonly sessions: DataMap<SessionRecord> = new Map();
  private readonly documents: DataMap<DocumentMetadataRecord> = new Map();
  private readonly extractions = new Map<
    string,
    { record: ExtractedDocument; caseId: string; cachedAt: number }
  >();
  private readonly tasks: DataMap<Task> = new Map();
  private readonly findings: DataMap<Finding> = new Map();
  private readonly evidence: DataMap<Evidence> = new Map();
  private readonly deliverables: DataMap<Deliverable> = new Map();
  private readonly approvals: DataMap<Approval> = new Map();
  private readonly runs: DataMap<RunRecord> = new Map();
  private readonly events: DataMap<RunEvent> = new Map();
  private readonly usage: Map<
    string,
    { record: UsageRecord; runId: string; scope: OwnerScope }
  > = new Map();
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

  constructor(options: { pageSize?: number } = {}) {
    this.pageSize = options.pageSize ?? 50;
    this.repositories = {
      agentProfiles: {
        listEnabled: async () =>
          [...this.profiles.values()]
            .filter((record) => record.enabled)
            .sort((a, b) => a.role.localeCompare(b.role))
            .map((record) => parse(AgentProfileSchema, record)),
        findByRole: async (role) => {
          const record = [...this.profiles.values()].find(
            (profile) => profile.role === role,
          );
          return record ? parse(AgentProfileSchema, record) : null;
        },
        upsert: async (profile) => {
          const record = parse(AgentProfileSchema, profile);
          this.profiles.set(record.role, record);
        },
      },
      cases: {
        findOwnedById: async (id, ownerId) => {
          const record = this.cases.get(id);
          return record &&
            record.ownerId === ownerId &&
            !record.isSample &&
            record.status !== "deleted"
            ? parse(CaseSchema, record)
            : null;
        },
        findPublicSampleById: async (id) => {
          const record = this.cases.get(id);
          return record &&
            record.isSample &&
            record.synthetic &&
            record.ownerId === null &&
            record.status !== "deleted"
            ? parse(CaseSchema, record)
            : null;
        },
        listOwned: async (ownerId, cursor) => {
          let cursorCase: Case | undefined;
          if (cursor) {
            cursorCase = this.cases.get(cursor);
            if (
              !cursorCase ||
              cursorCase.ownerId !== ownerId ||
              cursorCase.isSample ||
              cursorCase.status === "deleted"
            ) {
              throw new InvalidCursorError();
            }
          }
          return [...this.cases.values()]
            .filter(
              (record) =>
                record.ownerId === ownerId &&
                !record.isSample &&
                record.status !== "deleted" &&
                (!cursorCase ||
                  record.createdAt < cursorCase.createdAt ||
                  (record.createdAt === cursorCase.createdAt &&
                    record.id < cursorCase.id)),
            )
            .sort(
              (a, b) =>
                b.createdAt.localeCompare(a.createdAt) ||
                b.id.localeCompare(a.id),
            )
            .slice(0, this.pageSize)
            .map((record) => parse(CaseSchema, record));
        },
        insert: async (caseRecord) => {
          const record = parse(CaseSchema, caseRecord);
          if (this.cases.has(record.id)) duplicate();
          this.cases.set(record.id, record);
        },
        replaceOwned: async (caseRecord, ownerId) => {
          const record = parse(CaseSchema, caseRecord);
          const current = this.cases.get(record.id);
          if (
            !current ||
            current.ownerId !== ownerId ||
            record.ownerId !== ownerId ||
            record.isSample
          ) {
            return false;
          }
          this.cases.set(record.id, record);
          return true;
        },
      },
      users: {
        findById: async (id) => {
          const record = this.users.get(id);
          return record ? parse(UserRecordSchema, record) : null;
        },
        findByEmail: async (email) => {
          const key = email.trim().toLowerCase();
          const record = [...this.users.values()].find(
            (user) => user.email.trim().toLowerCase() === key,
          );
          return record ? parse(UserRecordSchema, record) : null;
        },
        insert: async (user) => {
          const record = parse(UserRecordSchema, user);
          if (this.users.has(record.id)) duplicate();
          if (
            [...this.users.values()].some(
              (other) =>
                other.email.trim().toLowerCase() ===
                record.email.trim().toLowerCase(),
            )
          ) {
            duplicate("A user with this email already exists");
          }
          this.users.set(record.id, record);
        },
        replace: async (user) => {
          const record = parse(UserRecordSchema, user);
          if (!this.users.has(record.id)) return false;
          if (
            [...this.users.values()].some(
              (other) =>
                other.id !== record.id &&
                other.email.trim().toLowerCase() ===
                  record.email.trim().toLowerCase(),
            )
          ) {
            duplicate("A user with this email already exists");
          }
          this.users.set(record.id, record);
          return true;
        },
      },
      accessKeys: {
        findActiveById: async (id) => {
          const record = this.accessKeys.get(id);
          return record?.revokedAt === null
            ? parse(AccessKeyRecordSchema, record)
            : null;
        },
        insert: async (key) => {
          const record = parse(AccessKeyRecordSchema, key);
          if (this.accessKeys.has(record.id)) duplicate();
          this.accessKeys.set(record.id, record);
        },
        revoke: async (id, revokedAt) => {
          const record = this.accessKeys.get(id);
          if (!record || record.revokedAt !== null) return false;
          this.accessKeys.set(
            id,
            parse(AccessKeyRecordSchema, { ...record, revokedAt }),
          );
          return true;
        },
      },
      sessions: {
        findActiveById: async (id, at) => {
          const record = this.sessions.get(id);
          return record && record.revokedAt === null && record.expiresAt > at
            ? parse(SessionRecordSchema, record)
            : null;
        },
        insert: async (session) => {
          const record = parse(SessionRecordSchema, session);
          if (this.sessions.has(record.id)) duplicate();
          this.sessions.set(record.id, record);
        },
        revoke: async (id, revokedAt) => {
          const record = this.sessions.get(id);
          if (!record || record.revokedAt !== null) return false;
          this.sessions.set(
            id,
            parse(SessionRecordSchema, { ...record, revokedAt }),
          );
          return true;
        },
      },
      documents: {
        findOwned: async (id, scope) => {
          if (!this.ownsCase(scope)) return null;
          const record = this.documents.get(id);
          return record?.caseId === scope.caseId
            ? parse(DocumentMetadataRecordSchema, record)
            : null;
        },
        listOwned: async (scope) => {
          if (!this.ownsCase(scope)) return [];
          return [...this.documents.values()]
            .filter((record) => record.caseId === scope.caseId)
            .sort(
              (a, b) =>
                a.uploadedAt.localeCompare(b.uploadedAt) ||
                a.id.localeCompare(b.id),
            )
            .map((record) =>
              DocumentMetadataDtoSchema.parse(
                parse(DocumentMetadataRecordSchema, record),
              ),
            );
        },
        insert: async (document, scope) => {
          const record = parse(DocumentMetadataRecordSchema, document);
          this.requireScope(record.caseId, scope);
          if (this.documents.has(record.id)) duplicate();
          this.documents.set(record.id, record);
        },
        replaceOwned: async (document, scope) => {
          const record = parse(DocumentMetadataRecordSchema, document);
          if (!this.ownsCase(scope) || record.caseId !== scope.caseId) {
            return false;
          }
          const current = this.documents.get(record.id);
          if (!current || current.caseId !== scope.caseId) return false;
          this.documents.set(record.id, record);
          return true;
        },
      },
      extractions: {
        findForDocument: async (documentId, scope) => {
          if (!this.ownsCase(scope)) return null;
          const records = [...this.extractions.values()]
            .filter(
              (item) =>
                item.record.documentId === documentId &&
                item.caseId === scope.caseId,
            )
            .sort((a, b) => b.cachedAt - a.cachedAt);
          return records[0]
            ? parse(ExtractedDocumentSchema, records[0].record)
            : null;
        },
        saveForDocument: async (extraction, scope) => {
          const record = parse(ExtractedDocumentSchema, extraction);
          this.requireScope(scope.caseId, scope);
          const document = this.documents.get(record.documentId);
          if (!document || document.caseId !== scope.caseId) {
            throw new StoreError(
              "Document does not belong to this case",
              "document-not-owned",
            );
          }
          const id = this.extractionKey(record);
          this.extractions.set(id, {
            record,
            caseId: scope.caseId,
            cachedAt: Date.now(),
          });
        },
      },
      evidence: {
        listForCase: async (scope) =>
          this.listChildren(this.evidence, scope, EvidenceSchema),
        insert: async (evidence, scope) =>
          this.insertChild(this.evidence, evidence, scope, EvidenceSchema),
      },
      findings: {
        listForCase: async (scope) =>
          this.listChildren(this.findings, scope, FindingSchema),
        insert: async (finding, scope) =>
          this.insertChild(this.findings, finding, scope, FindingSchema),
      },
      tasks: {
        listForRun: async (runId, scope) => {
          if (!this.ownsCase(scope)) return [];
          const run = this.runs.get(runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            return [];
          }
          return [...this.tasks.values()]
            .filter(
              (task) => task.runId === runId && task.caseId === scope.caseId,
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((task) => parse(TaskSchema, task));
        },
        insert: async (task, scope) => {
          const record = parse(TaskSchema, task);
          this.requireScope(record.caseId, scope);
          const run = this.runs.get(record.runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            throw new StoreError(
              "Run does not belong to this case",
              "run-not-owned",
            );
          }
          if (this.tasks.has(record.id)) duplicate();
          this.tasks.set(record.id, record);
        },
      },
      runs: {
        findOwnedById: async (id, ownerId) => {
          const record = this.runs.get(id);
          return record?.ownerId === ownerId
            ? parse(RunRecordSchema, record)
            : null;
        },
        insert: async (run) => {
          const record = parse(RunRecordSchema, run);
          if (this.runs.has(record.id)) duplicate();
          if (
            !this.ownsCase({ caseId: record.caseId, ownerId: record.ownerId })
          ) {
            throw new CaseNotOwnedError();
          }
          if (
            ["queued", "running"].includes(record.status) &&
            [...this.runs.values()].some(
              (other) =>
                other.ownerId === record.ownerId &&
                other.caseId === record.caseId &&
                ["queued", "running"].includes(other.status),
            )
          ) {
            duplicate("An active run already exists for this case");
          }
          this.runs.set(record.id, record);
        },
        updateOwned: async (run, ownerId) => {
          const record = parse(RunRecordSchema, run);
          const current = this.runs.get(record.id);
          if (
            !current ||
            current.ownerId !== ownerId ||
            record.ownerId !== ownerId ||
            current.caseId !== record.caseId
          ) {
            return false;
          }
          if (
            ["queued", "running"].includes(record.status) &&
            [...this.runs.values()].some(
              (other) =>
                other.id !== record.id &&
                other.ownerId === ownerId &&
                other.caseId === record.caseId &&
                ["queued", "running"].includes(other.status),
            )
          ) {
            duplicate("An active run already exists for this case");
          }
          this.runs.set(record.id, record);
          return true;
        },
      },
      deliverables: {
        findOwnedById: async (id, scope) => {
          if (!this.ownsCase(scope)) return null;
          const record = this.deliverables.get(id);
          return record?.caseId === scope.caseId
            ? parse(DeliverableSchema, record)
            : null;
        },
        listForRun: async (runId, scope) => {
          if (!this.ownsCase(scope)) return [];
          const run = this.runs.get(runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            return [];
          }
          return [...this.deliverables.values()]
            .filter(
              (item) => item.runId === runId && item.caseId === scope.caseId,
            )
            .sort((a, b) => b.version - a.version || a.id.localeCompare(b.id))
            .map((item) => parse(DeliverableSchema, item));
        },
        insert: async (deliverable, scope) => {
          const record = parse(DeliverableSchema, deliverable);
          this.requireScope(record.caseId, scope);
          if (this.deliverables.has(record.id)) duplicate();
          const run = this.runs.get(record.runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            throw new StoreError(
              "Run does not belong to this case",
              "run-not-owned",
            );
          }
          this.deliverables.set(record.id, record);
        },
        replaceOwned: async (deliverable, scope) => {
          const record = parse(DeliverableSchema, deliverable);
          if (!this.ownsCase(scope) || record.caseId !== scope.caseId) {
            return false;
          }
          const current = this.deliverables.get(record.id);
          if (!current || current.caseId !== scope.caseId) return false;
          if (current.version !== record.version) {
            for (const [id, approval] of this.approvals) {
              if (approval.deliverableId === record.id) {
                this.approvals.delete(id);
              }
            }
          }
          this.deliverables.set(record.id, record);
          return true;
        },
      },
      approvals: {
        findForDeliverable: async (deliverableId, scope) => {
          if (!this.ownsCase(scope)) return null;
          const approval = [...this.approvals.values()].find(
            (item) =>
              item.deliverableId === deliverableId &&
              item.caseId === scope.caseId,
          );
          return approval ? parse(ApprovalSchema, approval) : null;
        },
        insert: async (approval, scope) => {
          const record = parse(ApprovalSchema, approval);
          this.requireScope(record.caseId, scope);
          const deliverable = this.deliverables.get(record.deliverableId);
          if (
            !deliverable ||
            deliverable.caseId !== scope.caseId ||
            deliverable.version !== record.deliverableVersion
          ) {
            throw new StoreError(
              "Deliverable version is not current",
              "stale-approval",
            );
          }
          if (
            [...this.approvals.values()].some(
              (item) =>
                item.id === record.id ||
                item.deliverableId === record.deliverableId,
            )
          ) {
            duplicate();
          }
          this.approvals.set(record.id, record);
        },
        invalidateForDeliverable: async (deliverableId, scope) => {
          if (!this.ownsCase(scope)) return;
          for (const [id, approval] of this.approvals) {
            if (
              approval.deliverableId === deliverableId &&
              approval.caseId === scope.caseId
            ) {
              this.approvals.delete(id);
            }
          }
        },
      },
      events: {
        append: async (event, scope) => {
          const record = parse(RunEventSchema, event);
          this.requireScope(record.caseId, scope);
          const run = this.runs.get(record.runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            throw new StoreError(
              "Run does not belong to this case",
              "run-not-found",
            );
          }
          if (
            [...this.events.values()].some(
              (existing) =>
                existing.caseId === record.caseId &&
                existing.sequence >= record.sequence,
            )
          ) {
            throw new StoreError(
              "Run event sequence must increase monotonically for its case",
              "event-sequence-conflict",
            );
          }
          if (this.events.has(record.id)) duplicate();
          this.events.set(record.id, record);
        },
        listAfter: async (caseId, afterSequence, scope) => {
          if (caseId !== scope.caseId || !this.ownsCase(scope)) return [];
          return [...this.events.values()]
            .filter(
              (event) =>
                event.caseId === caseId && event.sequence > afterSequence,
            )
            .sort((a, b) => a.sequence - b.sequence)
            .map((event) => parse(RunEventSchema, event));
        },
      },
      usage: {
        listForRun: async (runId, scope) => {
          if (!this.ownsCase(scope)) return [];
          return [...this.usage.values()]
            .filter(
              (entry) =>
                entry.runId === runId &&
                entry.scope.caseId === scope.caseId &&
                entry.scope.ownerId === scope.ownerId,
            )
            .map((entry) => parse(UsageRecordSchema, entry.record));
        },
        insert: async (usage, runId, scope) => {
          const record = parse(UsageRecordSchema, usage);
          this.requireScope(scope.caseId, scope);
          if (this.usage.has(record.id)) duplicate();
          if (
            [...this.usage.values()].some(
              (entry) => entry.record.attemptId === record.attemptId,
            )
          ) {
            duplicate("A usage attempt with this ID already exists");
          }
          const run = this.runs.get(runId);
          if (
            !run ||
            run.ownerId !== scope.ownerId ||
            run.caseId !== scope.caseId
          ) {
            throw new StoreError(
              "Run does not belong to this case",
              "run-not-owned",
            );
          }
          this.usage.set(record.id, { record, runId, scope });
        },
      },
    };
  }

  private ownsCase(scope: OwnerScope): boolean {
    const record = this.cases.get(scope.caseId);
    return Boolean(
      record &&
        record.ownerId === scope.ownerId &&
        !record.isSample &&
        record.status !== "deleted",
    );
  }

  private requireScope(caseId: string, scope: OwnerScope): void {
    if (caseId !== scope.caseId || !this.ownsCase(scope)) {
      throw new CaseNotOwnedError();
    }
  }

  private listChildren<T extends { id: string; caseId: string }>(
    records: DataMap<T>,
    scope: OwnerScope,
    schema: ZodType<T>,
  ): Promise<T[]> {
    if (!this.ownsCase(scope)) return Promise.resolve([]);
    return Promise.resolve(
      [...records.values()]
        .filter((record) => record.caseId === scope.caseId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((record) => parse(schema, record)),
    );
  }

  private async insertChild<T extends { id: string; caseId: string }>(
    records: DataMap<T>,
    value: T,
    scope: OwnerScope,
    schema: ZodType<T>,
  ): Promise<void> {
    const record = parse(schema, value);
    this.requireScope(record.caseId, scope);
    if (records.has(record.id)) duplicate();
    records.set(record.id, record);
  }

  private extractionKey(record: ExtractedDocument): string {
    return [
      record.documentId,
      record.cacheIdentity.contentHash,
      record.cacheIdentity.extractorVersion,
      record.cacheIdentity.modelVersion ?? "none",
    ]
      .map(encodeURIComponent)
      .join(":");
  }
}

export function createInMemoryStore(
  options?: ConstructorParameters<typeof InMemoryStore>[0],
): InMemoryStore {
  return new InMemoryStore(options);
}
