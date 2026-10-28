import type {
  Case,
  AccessKeyRecord,
  Approval,
  DocumentMetadataRecord,
  DocumentMetadataDto,
  Deliverable,
  ExtractedDocument,
  Finding,
  RunEvent,
  RunRecord,
  SessionRecord,
  Task,
  UserRecord,
  UsageRecord,
  UsageReservation,
} from "./domain.js";

export interface OwnerScope {
  ownerId: string;
  caseId: string;
}

export interface CaseRepository {
  findOwnedById(id: string, ownerId: string): Promise<Case | null>;
  findPublicSampleById(id: string): Promise<Case | null>;
  listOwned(ownerId: string, cursor?: string): Promise<Case[]>;
  insert(record: Case): Promise<void>;
  replaceOwned(record: Case, ownerId: string): Promise<boolean>;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  insert(user: UserRecord): Promise<void>;
  replace(user: UserRecord): Promise<boolean>;
}

export interface AccessKeyRepository {
  findActiveById(id: string): Promise<AccessKeyRecord | null>;
  insert(record: AccessKeyRecord): Promise<void>;
  revoke(id: string, revokedAt: string): Promise<boolean>;
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
  insert(record: DocumentMetadataRecord): Promise<void>;
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
}

export interface RunRepository {
  findOwnedById(id: string, ownerId: string): Promise<RunRecord | null>;
  insert(run: RunRecord): Promise<void>;
  updateOwned(run: RunRecord, ownerId: string): Promise<boolean>;
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
  append(event: RunEvent): Promise<void>;
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

export interface DocumentStore {
  put(objectKey: string, object: StoredObject): Promise<void>;
  get(objectKey: string): Promise<StoredObject | null>;
  delete(objectKey: string): Promise<void>;
}

export interface UsageReservationRequest {
  ownerId: string;
  caseId: string;
  runId: string;
  amountUsd: number;
  idempotencyKey: string;
}

export interface UsageSettlement {
  reservation: UsageReservation;
  usage: UsageRecord;
}

export interface UsageAdmissionPort {
  reserve(request: UsageReservationRequest): Promise<UsageReservation>;
  settle(settlement: UsageSettlement): Promise<void>;
  release(reservationId: string, reason: "cancelled" | "failed"): Promise<void>;
}
