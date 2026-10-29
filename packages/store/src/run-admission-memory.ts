import type {
  Case,
  RunAdmissionLease,
  RunAdmissionPort,
  RunAdmissionRequest,
  RunRecord,
} from "@evianta/core";
import { StoreError } from "./errors.js";

type RunLock = {
  ownerId: string;
  caseId: string;
  runId: string;
  state: "active" | "waiting-for-input" | "released";
  leaseId: string | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
  updatedAt: string;
};

function lockId(ownerId: string, caseId: string): string {
  return JSON.stringify([ownerId, caseId]);
}

export class InMemoryRunAdmissionRepository implements RunAdmissionPort {
  private readonly locks = new Map<string, RunLock>();
  private readonly userCounts = new Map<string, number>();
  private globalCount = 0;

  constructor(
    private readonly findOwnedCase: (
      caseId: string,
      ownerId: string,
    ) => Case | null,
    private readonly findOwnedRun: (
      runId: string,
      caseId: string,
      ownerId: string,
    ) => RunRecord | null,
  ) {}

  async acquire(request: RunAdmissionRequest): Promise<RunAdmissionLease> {
    this.validateRequest(request);
    this.reapExpired(request.at);
    const parent = this.findOwnedCase(request.caseId, request.ownerId);
    if (!parent || parent.isSample || parent.status === "deleted") {
      throw new StoreError(
        "The case does not exist in the requested owner scope",
        "case-not-owned",
      );
    }
    const run = this.findOwnedRun(
      request.runId,
      request.caseId,
      request.ownerId,
    );
    if (
      !run ||
      !["queued", "running"].includes(run.status) ||
      run.cancellationRequested
    ) {
      throw new StoreError(
        "The run does not belong to this case and owner",
        "run-not-owned",
      );
    }
    const id = lockId(request.ownerId, request.caseId);
    const existing = this.locks.get(id);
    if (existing && existing.state !== "released") {
      throw new StoreError(
        "Another run already holds this case admission",
        "run-case-active",
      );
    }
    this.assertCapacity(
      request.ownerId,
      request.userLimit,
      request.globalLimit,
    );
    this.increment(request.ownerId);
    const fencingToken = (existing?.fencingToken ?? 0) + 1;
    this.locks.set(id, {
      ownerId: request.ownerId,
      caseId: request.caseId,
      runId: request.runId,
      state: "active",
      leaseId: request.leaseId,
      fencingToken,
      leaseExpiresAt: request.expiresAt,
      updatedAt: request.at,
    });
    return {
      leaseId: request.leaseId,
      fencingToken,
      expiresAt: request.expiresAt,
    };
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
    const lock = this.locks.get(id);
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
    this.decrement(request.ownerId);
    this.locks.set(id, {
      ...lock,
      state: "waiting-for-input",
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: request.at,
    });
    return true;
  }

  async resume(
    request: RunAdmissionRequest & { fencingToken: number },
  ): Promise<RunAdmissionLease> {
    this.validateRequest(request);
    this.reapExpired(request.at);
    const id = lockId(request.ownerId, request.caseId);
    const lock = this.locks.get(id);
    if (
      !lock ||
      lock.runId !== request.runId ||
      lock.state !== "waiting-for-input" ||
      lock.fencingToken !== request.fencingToken
    ) {
      throw new StoreError(
        "The waiting run admission is stale",
        "stale-run-admission",
      );
    }
    const parent = this.findOwnedCase(request.caseId, request.ownerId);
    if (!parent || parent.isSample || parent.status === "deleted") {
      throw new StoreError(
        "The case does not exist in the requested owner scope",
        "case-not-owned",
      );
    }
    const run = this.findOwnedRun(
      request.runId,
      request.caseId,
      request.ownerId,
    );
    if (
      !run ||
      run.status !== "waiting-for-input" ||
      !run.inputRequired ||
      run.cancellationRequested
    ) {
      throw new StoreError(
        "The run does not belong to this case and owner",
        "run-not-owned",
      );
    }
    this.assertCapacity(
      request.ownerId,
      request.userLimit,
      request.globalLimit,
    );
    this.increment(request.ownerId);
    const fencingToken = lock.fencingToken + 1;
    this.locks.set(id, {
      ...lock,
      state: "active",
      leaseId: request.leaseId,
      fencingToken,
      leaseExpiresAt: request.expiresAt,
      updatedAt: request.at,
    });
    return {
      leaseId: request.leaseId,
      fencingToken,
      expiresAt: request.expiresAt,
    };
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
    const lock = this.locks.get(id);
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
    if (lock.state === "active") this.decrement(request.ownerId);
    this.locks.set(id, {
      ...lock,
      state: "released",
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: request.at,
    });
    return true;
  }

  private validateRequest(request: RunAdmissionRequest): void {
    if (
      !request.ownerId ||
      !request.caseId ||
      !request.runId ||
      !request.leaseId ||
      !Number.isInteger(request.userLimit) ||
      request.userLimit < 1 ||
      !Number.isInteger(request.globalLimit) ||
      request.globalLimit < 1 ||
      !Number.isFinite(Date.parse(request.at)) ||
      !Number.isFinite(Date.parse(request.expiresAt)) ||
      Date.parse(request.expiresAt) <= Date.parse(request.at)
    ) {
      throw new StoreError(
        "Invalid run admission request",
        "invalid-run-admission",
      );
    }
  }

  private assertCapacity(
    ownerId: string,
    userLimit: number,
    globalLimit: number,
  ): void {
    if ((this.userCounts.get(ownerId) ?? 0) >= userLimit) {
      throw new StoreError(
        "User concurrent-run limit reached",
        "run-concurrency-limit",
      );
    }
    if (this.globalCount >= globalLimit) {
      throw new StoreError(
        "Global concurrent-run limit reached",
        "run-concurrency-limit",
      );
    }
  }

  private increment(ownerId: string): void {
    this.userCounts.set(ownerId, (this.userCounts.get(ownerId) ?? 0) + 1);
    this.globalCount += 1;
  }

  private decrement(ownerId: string): void {
    const userCount = this.userCounts.get(ownerId) ?? 0;
    if (userCount < 1 || this.globalCount < 1) {
      throw new StoreError(
        "Run admission counter is inconsistent",
        "run-admission-counter-conflict",
      );
    }
    this.userCounts.set(ownerId, userCount - 1);
    this.globalCount -= 1;
  }

  private reapExpired(at: string): void {
    for (const [id, lock] of this.locks) {
      if (
        lock.state !== "active" ||
        !lock.leaseExpiresAt ||
        Date.parse(lock.leaseExpiresAt) > Date.parse(at)
      ) {
        continue;
      }
      this.decrement(lock.ownerId);
      this.locks.set(id, {
        ...lock,
        state: "released",
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: at,
      });
    }
  }
}
