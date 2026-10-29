import {
  CaseSchema,
  RunRecordSchema,
  type RunAdmissionLease,
  type RunAdmissionPort,
  type RunAdmissionRequest,
} from "@evianta/core";
import {
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
} from "mongodb";
import { z } from "zod";
import { StoreError } from "./errors.js";

type RunLock = {
  _id: string;
  ownerId: string;
  caseId: string;
  runId: string;
  state: "active" | "waiting-for-input" | "released";
  leaseId: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  updatedAt: string;
};

type StoredDocument = Document & { _id: string };

const RunLockSchema = z.object({
  _id: z.string().min(1),
  ownerId: z.string().min(1),
  caseId: z.string().min(1),
  runId: z.string().min(1),
  state: z.enum(["active", "waiting-for-input", "released"]),
  leaseId: z.string().min(1).nullable(),
  fencingToken: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});

const RequestSchema = z
  .object({
    ownerId: z.string().min(1),
    caseId: z.string().min(1),
    runId: z.string().min(1),
    leaseId: z.string().min(1),
    at: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    userLimit: z.number().int().positive(),
    globalLimit: z.number().int().positive(),
  })
  .refine(
    (request) => Date.parse(request.expiresAt) > Date.parse(request.at),
    "Lease expiry must be after acquisition time",
  );

function lockId(ownerId: string, caseId: string): string {
  return JSON.stringify([ownerId, caseId]);
}

function counterId(scope: "global" | "user", ownerId?: string): string {
  return scope === "global" ? "global" : `user:${ownerId}`;
}

function parseLock(document: Document | null): RunLock | null {
  if (!document) return null;
  return RunLockSchema.parse(document);
}

function canonicalTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

export class MongoRunAdmissionRepository implements RunAdmissionPort {
  private readonly cases: Collection<StoredDocument>;
  private readonly runs: Collection<StoredDocument>;
  private readonly locks: Collection<RunLock>;
  private readonly counters: Collection<StoredDocument>;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.cases = db.collection<StoredDocument>("cases");
    this.runs = db.collection<StoredDocument>("runs");
    this.locks = db.collection<RunLock>("runAdmissions");
    this.counters = db.collection<StoredDocument>("runAdmissionCounters");
  }

  async initialize(): Promise<void> {
    await this.locks.createIndex({ state: 1, leaseExpiresAt: 1 });
    await this.backfillActiveRuns();
    await this.backfillWaitingRuns();
  }

  async acquire(input: RunAdmissionRequest): Promise<RunAdmissionLease> {
    const parsedRequest = RequestSchema.parse(input);
    const request = {
      ...parsedRequest,
      at: canonicalTimestamp(parsedRequest.at),
      expiresAt: canonicalTimestamp(parsedRequest.expiresAt),
    };
    await this.reapExpired(request.at);
    return this.withTransaction(async (session) => {
      const parent = await this.cases.findOne(
        {
          _id: request.caseId,
          ownerId: request.ownerId,
          isSample: false,
          status: { $ne: "deleted" },
        },
        { session },
      );
      if (!parent || !CaseSchema.safeParse(withoutId(parent)).success) {
        throw new StoreError(
          "The case does not exist in the requested owner scope",
          "case-not-owned",
        );
      }
      const runDocument = await this.runs.findOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: { $in: ["queued", "running"] },
          cancellationRequested: false,
        },
        { session },
      );
      const run = runDocument
        ? RunRecordSchema.parse(withoutId(runDocument))
        : null;
      if (!run) {
        throw new StoreError(
          "The run does not belong to this case and owner",
          "run-not-owned",
        );
      }

      const id = lockId(request.ownerId, request.caseId);
      const existing = parseLock(
        await this.locks.findOne({ _id: id }, { session }),
      );
      if (
        existing &&
        existing.state !== "released" &&
        existing.runId !== request.runId
      ) {
        throw new StoreError(
          "Another run already holds this case admission",
          "run-case-active",
        );
      }
      if (existing?.state === "active") {
        throw new StoreError(
          "This run already holds an active admission",
          "run-case-active",
        );
      }
      if (existing?.state === "waiting-for-input") {
        throw new StoreError(
          "This run is waiting for input and retains its case admission",
          "run-case-active",
        );
      }

      await this.ensureCounter(counterId("user", request.ownerId), session);
      await this.ensureCounter(counterId("global"), session);
      await this.increaseCounter(
        counterId("user", request.ownerId),
        request.userLimit,
        session,
      );
      await this.increaseCounter(
        counterId("global"),
        request.globalLimit,
        session,
      );

      const fencingToken = run.fencingToken + 1;
      const runUpdate = await this.runs.updateOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          fencingToken: run.fencingToken,
          status: { $in: ["queued", "running"] },
          cancellationRequested: false,
        },
        {
          $set: {
            status: "running",
            inputRequired: false,
            leaseId: request.leaseId,
            leaseExpiresAt: request.expiresAt,
            fencingToken,
            updatedAt: request.at,
          },
        },
        { session },
      );
      if (runUpdate.matchedCount !== 1) {
        throw new StoreError(
          "Run lease changed during admission",
          "stale-run-admission",
        );
      }
      await this.locks.replaceOne(
        { _id: id },
        {
          ownerId: request.ownerId,
          caseId: request.caseId,
          runId: request.runId,
          state: "active",
          leaseId: request.leaseId,
          fencingToken,
          leaseExpiresAt: request.expiresAt,
          updatedAt: request.at,
        },
        { upsert: true, session },
      );
      return {
        leaseId: request.leaseId,
        fencingToken,
        expiresAt: request.expiresAt,
      };
    });
  }

  async renew(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string;
    fencingToken: number;
    at: string;
    expiresAt: string;
  }): Promise<RunAdmissionLease | null> {
    const atTime = Date.parse(request.at);
    const expiresAtTime = Date.parse(request.expiresAt);
    if (
      !Number.isFinite(atTime) ||
      !Number.isFinite(expiresAtTime) ||
      expiresAtTime <= atTime
    ) {
      throw new StoreError(
        "Invalid run admission renewal",
        "invalid-run-admission",
      );
    }
    const at = canonicalTimestamp(request.at);
    const id = lockId(request.ownerId, request.caseId);
    return this.withTransaction(async (session) => {
      const lock = parseLock(
        await this.locks.findOne({ _id: id }, { session }),
      );
      if (
        !lock ||
        lock.runId !== request.runId ||
        lock.state !== "active" ||
        lock.leaseId !== request.leaseId ||
        lock.fencingToken !== request.fencingToken ||
        !lock.leaseExpiresAt ||
        Date.parse(lock.leaseExpiresAt) <= atTime
      ) {
        return null;
      }
      const renewedExpiresAt = new Date(
        Math.max(expiresAtTime, Date.parse(lock.leaseExpiresAt)),
      ).toISOString();
      const runDocument = await this.runs.findOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: "running",
          cancellationRequested: false,
          leaseId: request.leaseId,
          leaseExpiresAt: lock.leaseExpiresAt,
          fencingToken: request.fencingToken,
        },
        { session },
      );
      if (!runDocument) return null;
      const run = RunRecordSchema.parse(withoutId(runDocument));
      const runUpdate = await this.runs.updateOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: "running",
          cancellationRequested: false,
          leaseId: request.leaseId,
          leaseExpiresAt: lock.leaseExpiresAt,
          fencingToken: request.fencingToken,
        },
        { $set: { leaseExpiresAt: renewedExpiresAt, updatedAt: at } },
        { session },
      );
      if (runUpdate.matchedCount !== 1) return null;
      const lockUpdate = await this.locks.updateOne(
        {
          _id: id,
          state: "active",
          runId: request.runId,
          leaseId: request.leaseId,
          leaseExpiresAt: lock.leaseExpiresAt,
          fencingToken: request.fencingToken,
        },
        {
          $set: { leaseExpiresAt: renewedExpiresAt, updatedAt: at },
          $inc: { renewalRevision: 1 },
        },
        { session },
      );
      if (lockUpdate.matchedCount !== 1) {
        throw new StoreError(
          "The run admission changed during lease renewal",
          "stale-run-admission",
        );
      }
      return {
        leaseId: request.leaseId,
        fencingToken: run.fencingToken,
        expiresAt: renewedExpiresAt,
      };
    });
  }

  async waitForInput(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string;
    fencingToken: number;
    at: string;
  }): Promise<number | null> {
    const id = lockId(request.ownerId, request.caseId);
    const at = canonicalTimestamp(request.at);
    return this.withTransaction(async (session) => {
      const lock = parseLock(
        await this.locks.findOne({ _id: id }, { session }),
      );
      if (
        !lock ||
        lock.runId !== request.runId ||
        lock.state !== "active" ||
        lock.leaseId !== request.leaseId ||
        lock.fencingToken !== request.fencingToken ||
        !lock.leaseExpiresAt ||
        Date.parse(lock.leaseExpiresAt) <= Date.parse(at)
      ) {
        return null;
      }
      const runDocument = await this.runs.findOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: "running",
          fencingToken: request.fencingToken,
          cancellationRequested: false,
        },
        { session },
      );
      const run = runDocument
        ? RunRecordSchema.parse(withoutId(runDocument))
        : null;
      if (!run) return null;
      const fencingToken = run.fencingToken + 1;
      const runUpdate = await this.runs.updateOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          fencingToken: run.fencingToken,
          status: "running",
        },
        {
          $set: {
            status: "waiting-for-input",
            inputRequired: true,
            leaseId: null,
            leaseExpiresAt: null,
            fencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (runUpdate.matchedCount !== 1) return null;
      const result = await this.locks.updateOne(
        {
          _id: id,
          state: "active",
          leaseId: request.leaseId,
          fencingToken: request.fencingToken,
        },
        {
          $set: {
            state: "waiting-for-input",
            leaseId: null,
            leaseExpiresAt: null,
            fencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new StoreError(
          "The run admission changed during the waiting transition",
          "stale-run-admission",
        );
      }
      await this.decreaseCounter(counterId("user", request.ownerId), session);
      await this.decreaseCounter(counterId("global"), session);
      return result.matchedCount === 1 ? fencingToken : null;
    });
  }

  async resume(
    input: RunAdmissionRequest & { fencingToken: number },
  ): Promise<RunAdmissionLease> {
    const parsedRequest = RequestSchema.parse(input);
    const request = {
      ...parsedRequest,
      at: canonicalTimestamp(parsedRequest.at),
      expiresAt: canonicalTimestamp(parsedRequest.expiresAt),
    };
    const id = lockId(request.ownerId, request.caseId);
    await this.reapExpired(request.at);
    return this.withTransaction(async (session) => {
      const lock = parseLock(
        await this.locks.findOne({ _id: id }, { session }),
      );
      if (
        !lock ||
        lock.runId !== request.runId ||
        lock.state !== "waiting-for-input" ||
        lock.fencingToken !== input.fencingToken
      ) {
        throw new StoreError(
          "The waiting run admission is stale",
          "stale-run-admission",
        );
      }
      const parent = await this.cases.findOne(
        {
          _id: request.caseId,
          ownerId: request.ownerId,
          isSample: false,
          status: { $ne: "deleted" },
        },
        { session },
      );
      if (!parent || !CaseSchema.safeParse(withoutId(parent)).success) {
        throw new StoreError(
          "The case does not exist in the requested owner scope",
          "case-not-owned",
        );
      }
      const runDocument = await this.runs.findOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: "waiting-for-input",
          inputRequired: true,
          cancellationRequested: false,
        },
        { session },
      );
      const run = runDocument
        ? RunRecordSchema.parse(withoutId(runDocument))
        : null;
      if (!run || run.fencingToken !== lock.fencingToken) {
        throw new StoreError(
          "The run does not belong to this case and owner",
          "run-not-owned",
        );
      }
      await this.ensureCounter(counterId("user", request.ownerId), session);
      await this.ensureCounter(counterId("global"), session);
      await this.increaseCounter(
        counterId("user", request.ownerId),
        request.userLimit,
        session,
      );
      await this.increaseCounter(
        counterId("global"),
        request.globalLimit,
        session,
      );
      const fencingToken = run.fencingToken + 1;
      const runUpdate = await this.runs.updateOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          status: "waiting-for-input",
          inputRequired: true,
          fencingToken: run.fencingToken,
          cancellationRequested: false,
        },
        {
          $set: {
            status: "running",
            inputRequired: false,
            leaseId: request.leaseId,
            leaseExpiresAt: request.expiresAt,
            fencingToken,
            updatedAt: request.at,
          },
        },
        { session },
      );
      if (runUpdate.matchedCount !== 1) {
        throw new StoreError(
          "Run lease changed during resume",
          "stale-run-admission",
        );
      }
      const result = await this.locks.updateOne(
        {
          _id: id,
          state: "waiting-for-input",
          runId: request.runId,
          fencingToken: input.fencingToken,
        },
        {
          $set: {
            state: "active",
            leaseId: request.leaseId,
            fencingToken,
            leaseExpiresAt: request.expiresAt,
            updatedAt: request.at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new StoreError(
          "The waiting run admission changed during resume",
          "stale-run-admission",
        );
      }
      return {
        leaseId: request.leaseId,
        fencingToken,
        expiresAt: request.expiresAt,
      };
    });
  }

  async release(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string | null;
    fencingToken: number;
    at: string;
  }): Promise<boolean> {
    const id = lockId(request.ownerId, request.caseId);
    const at = canonicalTimestamp(request.at);
    return this.withTransaction(async (session) => {
      const lock = parseLock(
        await this.locks.findOne({ _id: id }, { session }),
      );
      if (
        !lock ||
        lock.runId !== request.runId ||
        lock.fencingToken !== request.fencingToken ||
        (lock.state === "active" && lock.leaseId !== request.leaseId) ||
        (lock.state === "waiting-for-input" && request.leaseId !== null) ||
        lock.state === "released"
      ) {
        return false;
      }
      const runDocument = await this.runs.findOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          fencingToken: request.fencingToken,
        },
        { session },
      );
      if (!runDocument) return false;
      const run = RunRecordSchema.parse(withoutId(runDocument));
      const nextFencingToken = run.fencingToken + 1;
      const runUpdate = await this.runs.updateOne(
        {
          _id: request.runId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          fencingToken: run.fencingToken,
        },
        {
          $set: {
            leaseId: null,
            leaseExpiresAt: null,
            fencingToken: nextFencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (runUpdate.matchedCount !== 1) return false;
      const result = await this.locks.updateOne(
        {
          _id: id,
          runId: request.runId,
          state: lock.state,
          fencingToken: request.fencingToken,
        },
        {
          $set: {
            state: "released",
            leaseId: null,
            leaseExpiresAt: null,
            fencingToken: nextFencingToken,
            updatedAt: at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new StoreError(
          "The run admission changed during release",
          "stale-run-admission",
        );
      }
      if (lock.state === "active") {
        await this.decreaseCounter(counterId("user", request.ownerId), session);
        await this.decreaseCounter(counterId("global"), session);
      }
      return true;
    });
  }

  private async reapExpired(at: string): Promise<void> {
    while (true) {
      const reaped = await this.withTransaction((session) =>
        this.reapExpiredBatch(at, session),
      );
      if (reaped < 1_000) return;
    }
  }

  private async reapExpiredBatch(
    at: string,
    session: ClientSession,
  ): Promise<number> {
    const expired = await this.locks
      .find(
        {
          state: "active",
          $expr: {
            $lte: [
              { $toDate: "$leaseExpiresAt" },
              new Date(canonicalTimestamp(at)),
            ],
          },
        },
        { session },
      )
      .limit(1_000)
      .toArray();
    let reaped = 0;
    for (const document of expired) {
      const lock = parseLock(document);
      if (!lock) continue;
      const result = await this.locks.updateOne(
        {
          _id: lock._id,
          state: "active",
          leaseExpiresAt: lock.leaseExpiresAt,
          fencingToken: lock.fencingToken,
        },
        {
          $set: {
            state: "released",
            leaseId: null,
            leaseExpiresAt: null,
            fencingToken: lock.fencingToken + 1,
            updatedAt: at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) continue;
      const run = await this.runs.findOne(
        {
          _id: lock.runId,
          ownerId: lock.ownerId,
          caseId: lock.caseId,
          fencingToken: lock.fencingToken,
        },
        { session },
      );
      if (run) {
        await this.runs.updateOne(
          {
            _id: lock.runId,
            ownerId: lock.ownerId,
            caseId: lock.caseId,
            fencingToken: lock.fencingToken,
          },
          {
            $set: {
              leaseId: null,
              leaseExpiresAt: null,
              fencingToken: lock.fencingToken + 1,
              updatedAt: canonicalTimestamp(at),
            },
          },
          { session },
        );
      }
      await this.decreaseCounter(counterId("user", lock.ownerId), session);
      await this.decreaseCounter(counterId("global"), session);
      reaped += 1;
    }
    return reaped;
  }

  private async ensureCounter(
    id: string,
    session: ClientSession,
  ): Promise<void> {
    await this.counters.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, activeRuns: 0 } },
      { upsert: true, session },
    );
  }

  private async backfillActiveRuns(): Promise<void> {
    const at = new Date();
    const cursor = this.runs.find({
      status: "running",
      cancellationRequested: false,
      leaseId: { $type: "string", $ne: "" },
      leaseExpiresAt: { $type: "string" },
      $expr: { $gt: [{ $toDate: "$leaseExpiresAt" }, at] },
    });
    for await (const document of cursor) {
      const snapshot = RunRecordSchema.parse(withoutId(document));
      const id = lockId(snapshot.ownerId, snapshot.caseId);
      await this.withTransaction(async (session) => {
        const runDocument = await this.runs.findOne(
          {
            _id: snapshot.id,
            ownerId: snapshot.ownerId,
            caseId: snapshot.caseId,
            status: "running",
            cancellationRequested: false,
            leaseId: snapshot.leaseId,
            leaseExpiresAt: snapshot.leaseExpiresAt,
            fencingToken: snapshot.fencingToken,
            $expr: {
              $gt: [{ $toDate: "$leaseExpiresAt" }, at],
            },
          },
          { session },
        );
        if (!runDocument) return;
        const run = RunRecordSchema.parse(withoutId(runDocument));
        const existing = parseLock(
          await this.locks.findOne({ _id: id }, { session }),
        );
        if (
          existing?.state === "active" &&
          existing.runId === run.id &&
          existing.leaseId === run.leaseId &&
          existing.fencingToken === run.fencingToken &&
          existing.leaseExpiresAt === run.leaseExpiresAt
        ) {
          return;
        }
        if (existing) {
          throw new StoreError(
            "Cannot migrate running leases with conflicting case admissions",
            "run-admission-migration-conflict",
          );
        }

        const guard = await this.runs.updateOne(
          {
            _id: run.id,
            ownerId: run.ownerId,
            caseId: run.caseId,
            status: "running",
            cancellationRequested: false,
            leaseId: run.leaseId,
            leaseExpiresAt: run.leaseExpiresAt,
            fencingToken: run.fencingToken,
          },
          { $inc: { admissionMigrationRevision: 1 } },
          { session },
        );
        if (guard.matchedCount !== 1) return;

        await this.ensureCounter(counterId("user", run.ownerId), session);
        await this.ensureCounter(counterId("global"), session);
        await this.counters.updateOne(
          { _id: counterId("user", run.ownerId) },
          { $inc: { activeRuns: 1 } },
          { session },
        );
        await this.counters.updateOne(
          { _id: counterId("global") },
          { $inc: { activeRuns: 1 } },
          { session },
        );
        await this.locks.insertOne(
          {
            _id: id,
            ownerId: run.ownerId,
            caseId: run.caseId,
            runId: run.id,
            state: "active",
            leaseId: run.leaseId,
            fencingToken: run.fencingToken,
            leaseExpiresAt: run.leaseExpiresAt,
            updatedAt: run.updatedAt,
          },
          { session },
        );
      });
    }
  }

  private async backfillWaitingRuns(): Promise<void> {
    const cursor = this.runs.find({
      status: "waiting-for-input",
      inputRequired: true,
      cancellationRequested: false,
    });
    for await (const document of cursor) {
      const snapshot = RunRecordSchema.parse(withoutId(document));
      const id = lockId(snapshot.ownerId, snapshot.caseId);
      await this.withTransaction(async (session) => {
        const runDocument = await this.runs.findOne(
          {
            _id: snapshot.id,
            ownerId: snapshot.ownerId,
            caseId: snapshot.caseId,
            status: "waiting-for-input",
            inputRequired: true,
            cancellationRequested: false,
          },
          { session },
        );
        if (!runDocument) return;
        const run = RunRecordSchema.parse(withoutId(runDocument));
        const existing = parseLock(
          await this.locks.findOne({ _id: id }, { session }),
        );
        if (
          existing?.state === "waiting-for-input" &&
          existing.runId === run.id &&
          existing.fencingToken === run.fencingToken
        ) {
          return;
        }
        if (
          existing &&
          (existing.state !== "released" ||
            existing.fencingToken > run.fencingToken)
        ) {
          throw new StoreError(
            "Cannot migrate waiting runs with conflicting case admissions",
            "run-admission-migration-conflict",
          );
        }

        const guard = await this.runs.updateOne(
          {
            _id: run.id,
            ownerId: run.ownerId,
            caseId: run.caseId,
            status: "waiting-for-input",
            inputRequired: true,
            cancellationRequested: false,
            fencingToken: run.fencingToken,
          },
          { $inc: { admissionMigrationRevision: 1 } },
          { session },
        );
        if (guard.matchedCount !== 1) return;

        const waitingLock: RunLock = {
          _id: id,
          ownerId: run.ownerId,
          caseId: run.caseId,
          runId: run.id,
          state: "waiting-for-input",
          leaseId: null,
          fencingToken: run.fencingToken,
          leaseExpiresAt: null,
          updatedAt: run.updatedAt,
        };
        if (existing?.state === "released") {
          const result = await this.locks.replaceOne(
            {
              _id: id,
              state: "released",
              fencingToken: existing.fencingToken,
            },
            waitingLock,
            { session },
          );
          if (result.matchedCount !== 1) {
            throw new StoreError(
              "Waiting run admission changed during migration",
              "run-admission-migration-conflict",
            );
          }
        } else {
          await this.locks.insertOne(waitingLock, { session });
        }
      });
    }
  }

  private async increaseCounter(
    id: string,
    limit: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.counters.updateOne(
      { _id: id, activeRuns: { $lt: limit } },
      { $inc: { activeRuns: 1 } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new StoreError(
        `${id === "global" ? "Global" : "User"} concurrent-run limit reached`,
        "run-concurrency-limit",
      );
    }
  }

  private async decreaseCounter(
    id: string,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.counters.updateOne(
      { _id: id, activeRuns: { $gt: 0 } },
      { $inc: { activeRuns: -1 } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new StoreError(
        "Run admission counter is inconsistent",
        "run-admission-counter-conflict",
      );
    }
  }

  private async withTransaction<T>(
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = this.client.startSession();
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
}

function withoutId(record: Document): Document {
  const result = { ...record };
  delete result._id;
  return result;
}
