import type {
  Case,
  AccessKeyRecord,
  AgentProfile,
  Approval,
  DocumentMetadataRecord,
  DocumentMetadataDto,
  Deliverable,
  ExtractedDocument,
  Evidence,
  Finding,
  RunEvent,
  RunRecord,
  SessionRecord,
  Task,
  UserRecord,
  UsageRecord,
  UsageLedgerEntry,
  UsagePrice,
  UsageReservation,
  UsageUnits,
} from "./domain.js";

export interface OwnerScope {
  ownerId: string;
  caseId: string;
}

export interface AgentProfileRepository {
  listEnabled(): Promise<AgentProfile[]>;
  findByRole(role: string): Promise<AgentProfile | null>;
  upsert(profile: AgentProfile): Promise<void>;
}

export interface CaseRepository {
  findOwnedById(id: string, ownerId: string): Promise<Case | null>;
  findPublicSampleById(id: string): Promise<Case | null>;
  listOwned(ownerId: string, cursor?: string): Promise<Case[]>;
  insert(record: Case): Promise<void>;
  replaceOwned(record: Case, ownerId: string): Promise<boolean>;
}

export interface EvidenceRepository {
  listForCase(scope: OwnerScope): Promise<Evidence[]>;
  insert(evidence: Evidence, scope: OwnerScope): Promise<void>;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  insert(user: UserRecord): Promise<void>;
  replace(user: UserRecord): Promise<boolean>;
}

export interface AccessKeyRepository {
  findActiveById(id: string, at?: string): Promise<AccessKeyRecord | null>;
  insert(record: AccessKeyRecord): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<boolean>;
  markUsed(id: string, usedAt: string): Promise<void>;
}

export interface SessionRepository {
  findActiveById(id: string, at: string): Promise<SessionRecord | null>;
  insert(record: SessionRecord): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<boolean>;
}

export interface DocumentRepository {
  findOwned(
    id: string,
    scope: OwnerScope,
  ): Promise<DocumentMetadataRecord | null>;
  listOwned(scope: OwnerScope): Promise<DocumentMetadataDto[]>;
  insert(record: DocumentMetadataRecord, scope: OwnerScope): Promise<void>;
  replaceOwned(
    record: DocumentMetadataRecord,
    scope: OwnerScope,
  ): Promise<boolean>;
}

export interface ExtractionRepository {
  findForDocument(
    documentId: string,
    scope: OwnerScope,
  ): Promise<ExtractedDocument | null>;
  saveForDocument(
    extraction: ExtractedDocument,
    scope: OwnerScope,
  ): Promise<void>;
}

export interface FindingRepository {
  listForCase(scope: OwnerScope): Promise<Finding[]>;
  insert(finding: Finding, scope: OwnerScope): Promise<void>;
}

export interface TaskRepository {
  listForRun(runId: string, scope: OwnerScope): Promise<Task[]>;
  insert(task: Task, scope: OwnerScope): Promise<void>;
  /**
   * Replaces a task in its run. When a fencing token is supplied, the write
   * only succeeds while the run still carries that lease generation.
   */
  replaceOwned(
    task: Task,
    scope: OwnerScope,
    options?: { fencingToken: number },
  ): Promise<boolean>;
}

export interface RunRepository {
  findOwnedById(id: string, ownerId: string): Promise<RunRecord | null>;
  insert(run: RunRecord): Promise<void>;
  updateOwned(run: RunRecord, ownerId: string): Promise<boolean>;
  /**
   * Lists queued or running runs whose lease is absent or expired at `at`,
   * oldest first, so a worker can claim new or abandoned work.
   */
  listClaimable(at: string, limit?: number): Promise<RunRecord[]>;
}

export interface DeliverableRepository {
  findOwnedById(id: string, scope: OwnerScope): Promise<Deliverable | null>;
  listForRun(runId: string, scope: OwnerScope): Promise<Deliverable[]>;
  insert(deliverable: Deliverable, scope: OwnerScope): Promise<void>;
  replaceOwned(deliverable: Deliverable, scope: OwnerScope): Promise<boolean>;
}

export interface ApprovalRepository {
  findForDeliverable(
    deliverableId: string,
    scope: OwnerScope,
  ): Promise<Approval | null>;
  insert(approval: Approval, scope: OwnerScope): Promise<void>;
  invalidateForDeliverable(
    deliverableId: string,
    scope: OwnerScope,
  ): Promise<void>;
}

export interface RunEventRepository {
  append(
    event: RunEvent,
    scope: OwnerScope,
    options?: { fencingToken: number },
  ): Promise<void>;
  listAfter(
    caseId: string,
    afterSequence: number,
    scope: OwnerScope,
  ): Promise<RunEvent[]>;
}

export interface UsageRepository {
  listForRun(runId: string, scope: OwnerScope): Promise<UsageRecord[]>;
  insert(usage: UsageRecord, runId: string, scope: OwnerScope): Promise<void>;
}

export interface StoredObject {
  body: AsyncIterable<Uint8Array>;
  contentType: string;
  contentLength: number;
  contentHash: string;
}

export interface BoundedStream {
  body: AsyncIterable<Uint8Array>;
  contentLength: number;
  contentHash: string;
}

export interface DocumentStore {
  uploadAsync(
    caseId: string,
    mimeType: string,
    boundedStream: BoundedStream,
  ): Promise<string>;
  readBufferAsync(
    objectKey: string,
    maxBytes: number,
  ): Promise<Uint8Array | null>;
  readStreamAsync(objectKey: string): Promise<StoredObject | null>;
  deleteAsync(objectKey: string): Promise<void>;
}

export interface SignedDocumentStore extends DocumentStore {
  getSignedUrlAsync(
    objectKey: string,
    expiresInSeconds: number,
  ): Promise<string>;
}

export interface UsageReservationRequest {
  attemptId: string;
  idempotencyKey: string;
  ownerId: string;
  caseId: string;
  runId: string;
  leaseId: string;
  fencingToken: number;
  taskId: string | null;
  provider: string;
  model: string;
  settings: Record<string, unknown>;
  price: UsagePrice;
  inputAllowanceTokens: number;
  outputAllowanceTokens: number;
  searchRequested: boolean;
  userSpendLimitUsd: number;
  globalSpendLimitUsd: number;
  periodSeconds: number;
  at: string;
  expiresAt: string;
}

export interface UsageSettlement {
  reservation: UsageReservation;
  outcome: "success" | "failed" | "unknown" | "cancelled";
  units: UsageUnits;
  errorCode: string | null;
  at: string;
}

export interface UsageAdmissionPort {
  reserve(request: UsageReservationRequest): Promise<UsageReservation>;
  settle(settlement: UsageSettlement): Promise<void>;
  release(reservationId: string, reason: "cancelled" | "failed"): Promise<void>;
}

export interface UsagePriceRepository {
  findActive(
    provider: string,
    model: string,
    settingsKey: string,
    at: string,
  ): Promise<UsagePrice | null>;
  insert(price: UsagePrice): Promise<void>;
}

export interface UsageLedgerFilter {
  ownerId?: string;
  caseId?: string;
  runId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface UsageLedgerRepository {
  list(filter?: UsageLedgerFilter): Promise<UsageLedgerEntry[]>;
  listForRun(
    ownerId: string,
    caseId: string,
    runId: string,
  ): Promise<UsageLedgerEntry[]>;
  recoverExpired(at: string, limit?: number): Promise<number>;
}

export interface RunAdmissionRequest {
  ownerId: string;
  caseId: string;
  runId: string;
  leaseId: string;
  at: string;
  expiresAt: string;
  userLimit: number;
  globalLimit: number;
}

export interface RunAdmissionLease {
  leaseId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface RunAdmissionPort {
  acquire(request: RunAdmissionRequest): Promise<RunAdmissionLease>;
  renew(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string;
    fencingToken: number;
    at: string;
    expiresAt: string;
  }): Promise<RunAdmissionLease | null>;
  waitForInput(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string;
    fencingToken: number;
    at: string;
  }): Promise<number | null>;
  resume(
    request: RunAdmissionRequest & { fencingToken: number },
  ): Promise<RunAdmissionLease>;
  release(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string | null;
    fencingToken: number;
    at: string;
  }): Promise<boolean>;
}

export interface RateLimitRequest {
  key: string;
  limit: number;
  windowSeconds: number;
  at: string;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetAt: string;
}

export interface RateLimitRepository {
  consume(request: RateLimitRequest): Promise<RateLimitResult>;
}
