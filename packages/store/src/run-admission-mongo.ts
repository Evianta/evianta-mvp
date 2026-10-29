import {
  CaseSchema,
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

export class MongoRunAdmissionRepository implements RunAdmissionPort {
  private readonly cases: Collection<Document>;
  private readonly runs: Collection<Document>;
  private readonly locks: Collection<RunLock>;
  private readonly counters: Collection<Document>;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.cases = db.collection("cases");
    this.runs = db.collection("runs");
    this.locks = db.collection("runAdmissions");
    this.counters = db.collection("runAdmissionCounters");
  }

  async initialize(): Promise<void> {
    await this.locks.createIndex({ state: 1, leaseExpiresAt: 1 });
  }

  async acquire(input: RunAdmissionRequest): Promise<RunAdmissionLease> {
    const request = RequestSchema.parse(input);
    return this.withTransaction(async (session) => {
      await this.reapExpired(request.at, session);
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
      if (
        !(await this.runs.findOne(
          {
            _id: request.runId,
            ownerId: request.ownerId,
            caseId: request.caseId,
            status: { $in: ["queued", "running"] },
            cancellationRequested: false,
          },
          { session },
        ))
      ) {
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

      const fencingToken = (existing?.fencingToken ?? 0) + 1;
      await this.locks.replaceOne(
        { _id: id },
        {
          _id: id,
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

  async waitForInput(request: {
    ownerId: string;
    caseId: string;
    runId: string;
    leaseId: string;
    fencingToken: number;
    at: string;
  }): Promise<boolean> {
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
        Date.parse(lock.leaseExpiresAt) <= Date.parse(request.at)
      ) {
        return false;
      }
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
            updatedAt: request.at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) return false;
      await this.decreaseCounter(counterId("user", request.ownerId), session);
      await this.decreaseCounter(counterId("global"), session);
      return result.matchedCount === 1;
    });
  }

  async resume(
    input: RunAdmissionRequest & { fencingToken: number },
  ): Promise<RunAdmissionLease> {
    const request = RequestSchema.parse(input);
    const id = lockId(request.ownerId, request.caseId);
    return this.withTransaction(async (session) => {
      await this.reapExpired(request.at, session);
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
      if (
        !(await this.runs.findOne(
          {
            _id: request.runId,
            ownerId: request.ownerId,
            caseId: request.caseId,
            status: "waiting-for-input",
            inputRequired: true,
            cancellationRequested: false,
          },
          { session },
        ))
      ) {
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
      const fencingToken = lock.fencingToken + 1;
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
            updatedAt: request.at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) return false;
      if (lock.state === "active") {
        await this.decreaseCounter(counterId("user", request.ownerId), session);
        await this.decreaseCounter(counterId("global"), session);
      }
      return true;
    });
  }

  private async reapExpired(at: string, session: ClientSession): Promise<void> {
    const expired = await this.locks
      .find({ state: "active", leaseExpiresAt: { $lte: at } }, { session })
      .limit(1_000)
      .toArray();
    for (const document of expired) {
      const lock = parseLock(document);
      if (!lock) continue;
      const result = await this.locks.updateOne(
        {
          _id: lock._id,
          state: "active",
          leaseExpiresAt: { $lte: at },
          fencingToken: lock.fencingToken,
        },
        {
          $set: {
            state: "released",
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: at,
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) continue;
      await this.decreaseCounter(counterId("user", lock.ownerId), session);
      await this.decreaseCounter(counterId("global"), session);
    }
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
