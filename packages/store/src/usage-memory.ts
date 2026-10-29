import {
  UsageLedgerEntrySchema,
  UsagePriceSchema,
  UsageReservationSchema,
  UsageUnitsSchema,
  estimateUsageAllowance,
  estimateUsageCost,
  type Case,
  type RunRecord,
  type UsageAdmissionPort,
  type UsageLedgerEntry,
  type UsageLedgerFilter,
  type UsageLedgerRepository,
  type UsagePrice,
  type UsagePriceRepository,
  type UsageReservation,
  type UsageReservationRequest,
  type UsageSettlement,
  usdToSubunits,
} from "@evianta/core";
import { StoreError } from "./errors.js";

interface Budget {
  spentSubunits: number;
  reservedSubunits: number;
}

const unknownUnits = UsageUnitsSchema.parse({
  input: null,
  output: null,
  total: null,
  reasoning: null,
  cacheRead: null,
  cacheWrite: null,
  search: null,
});

function periodStart(at: string, periodSeconds: number): string {
  const periodMs = periodSeconds * 1000;
  return new Date(
    Math.floor(Date.parse(at) / periodMs) * periodMs,
  ).toISOString();
}

function priceIdentity(price: UsagePrice): string {
  return `${price.provider}:${price.model}:${price.settingsKey}:${price.version}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareUnits(
  left: UsageLedgerEntry["units"],
  right: UsageSettlement["units"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function moneySubunits(value: number): number {
  try {
    return usdToSubunits(value);
  } catch (error) {
    throw new StoreError(
      "USD value exceeds supported precision",
      "invalid-usd",
      {
        cause: error,
      },
    );
  }
}

export class InMemoryUsageRepository
  implements UsageAdmissionPort, UsagePriceRepository, UsageLedgerRepository
{
  private readonly prices = new Map<string, UsagePrice>();
  private readonly ledger = new Map<string, UsageLedgerEntry>();
  private readonly reservations = new Map<string, UsageReservation>();
  private readonly reservationKeys = new Map<string, string>();
  private readonly budgets = new Map<string, Budget>();

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
    private readonly hasActiveLease: (request: {
      ownerId: string;
      caseId: string;
      runId: string;
      leaseId: string;
      fencingToken: number;
      at: string;
    }) => boolean,
  ) {}

  async findActive(
    provider: string,
    model: string,
    settingsKey: string,
    at: string,
  ): Promise<UsagePrice | null> {
    const records = [...this.prices.values()]
      .filter(
        (price) =>
          price.provider === provider &&
          price.model === model &&
          price.settingsKey === settingsKey &&
          Date.parse(price.effectiveAt) <= Date.parse(at),
      )
      .sort(
        (left, right) =>
          Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt) ||
          right.version - left.version,
      );
    return records[0] ? structuredClone(records[0]) : null;
  }

  async insert(price: UsagePrice): Promise<void> {
    const record = UsagePriceSchema.parse(price);
    if (
      this.prices.has(record.id) ||
      [...this.prices.values()].some(
        (existing) => priceIdentity(existing) === priceIdentity(record),
      )
    ) {
      throw new StoreError(
        "A price with this provider, model, settings, and version already exists",
        "duplicate-price",
      );
    }
    this.prices.set(record.id, structuredClone(record));
  }

  async reserve(input: UsageReservationRequest): Promise<UsageReservation> {
    if (
      !Number.isFinite(input.userSpendLimitUsd) ||
      input.userSpendLimitUsd <= 0 ||
      !Number.isFinite(input.globalSpendLimitUsd) ||
      input.globalSpendLimitUsd <= 0 ||
      !Number.isInteger(input.periodSeconds) ||
      input.periodSeconds <= 0 ||
      !Number.isSafeInteger(input.inputAllowanceTokens) ||
      input.inputAllowanceTokens < 1 ||
      !Number.isSafeInteger(input.outputAllowanceTokens) ||
      input.outputAllowanceTokens < 1 ||
      Date.parse(input.expiresAt) <= Date.parse(input.at) ||
      input.price.provider !== input.provider ||
      input.price.model !== input.model
    ) {
      throw new StoreError(
        "Invalid usage reservation request",
        "invalid-reservation",
      );
    }
    const existingId = this.reservationKeys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.reservations.get(existingId)!;
      if (
        existing.attemptId !== input.attemptId ||
        existing.ownerId !== input.ownerId ||
        existing.caseId !== input.caseId ||
        existing.runId !== input.runId ||
        existing.periodSeconds !== input.periodSeconds ||
        existing.reservedUsd !==
          estimateUsageAllowance(
            input.inputAllowanceTokens,
            input.outputAllowanceTokens,
            input.searchRequested,
            input.price,
          )
      ) {
        throw new StoreError(
          "Usage idempotency key was reused with different request data",
          "idempotency-conflict",
        );
      }
      const existingEntry = this.ledger.get(existing.attemptId);
      if (
        !existingEntry ||
        existingEntry.provider !== input.provider ||
        existingEntry.model !== input.model ||
        existingEntry.priceId !== input.price.id ||
        existingEntry.priceVersion !== input.price.version ||
        existingEntry.inputAllowanceTokens !== input.inputAllowanceTokens ||
        existingEntry.outputAllowanceTokens !== input.outputAllowanceTokens ||
        existingEntry.searchRequested !== input.searchRequested ||
        canonicalJson(existingEntry.price) !== canonicalJson(input.price) ||
        canonicalJson(existingEntry.settings) !== canonicalJson(input.settings)
      ) {
        throw new StoreError(
          "Usage idempotency key was reused with different model data",
          "idempotency-conflict",
        );
      }
      throw new StoreError(
        "This usage attempt was already admitted and cannot be dispatched again",
        "usage-attempt-exists",
      );
    }
    const parent = this.findOwnedCase(input.caseId, input.ownerId);
    if (!parent || parent.isSample || parent.status === "deleted") {
      throw new StoreError(
        "The case does not exist in the requested owner scope",
        "case-not-owned",
      );
    }
    const run = this.findOwnedRun(input.runId, input.caseId, input.ownerId);
    if (
      !run ||
      run.status !== "running" ||
      run.cancellationRequested ||
      run.leaseId !== input.leaseId ||
      !run.leaseExpiresAt ||
      Date.parse(run.leaseExpiresAt) <= Date.parse(input.at) ||
      run.fencingToken !== input.fencingToken ||
      !this.hasActiveLease(input)
    ) {
      throw new StoreError(
        "Usage admission requires the run's active fenced lease",
        "run-admission-required",
      );
    }
    if (this.ledger.has(input.attemptId)) {
      throw new StoreError(
        "A usage attempt with this identity already exists",
        "duplicate-usage-attempt",
      );
    }
    const activePrice = [...this.prices.values()]
      .filter(
        (candidate) =>
          candidate.provider === input.provider &&
          candidate.model === input.model &&
          candidate.settingsKey === input.price.settingsKey &&
          Date.parse(candidate.effectiveAt) <= Date.parse(input.at),
      )
      .sort(
        (left, right) =>
          Date.parse(right.effectiveAt) - Date.parse(left.effectiveAt) ||
          right.version - left.version,
      )[0];
    if (
      !activePrice ||
      canonicalJson(activePrice) !== canonicalJson(input.price) ||
      canonicalJson(activePrice.settings) !== canonicalJson(input.settings) ||
      canonicalJson(input.price.settings) !== canonicalJson(input.settings)
    ) {
      throw new StoreError(
        "The admitted model price is not the active version for these settings",
        "price-not-active",
      );
    }
    const amountUsd = estimateUsageAllowance(
      input.inputAllowanceTokens,
      input.outputAllowanceTokens,
      input.searchRequested,
      input.price,
    );
    if (amountUsd === null) {
      throw new StoreError(
        "The requested capability has no bounded usage allowance",
        "unbounded-capability",
      );
    }
    const amountSubunits = moneySubunits(amountUsd);
    const userLimitSubunits = moneySubunits(input.userSpendLimitUsd);
    const globalLimitSubunits = moneySubunits(input.globalSpendLimitUsd);

    const start = periodStart(input.at, input.periodSeconds);
    const userKey = `user:${input.ownerId}:${input.periodSeconds}:${start}`;
    const globalKey = `global:${input.periodSeconds}:${start}`;
    const userBudget = this.budgets.get(userKey) ?? {
      spentSubunits: 0,
      reservedSubunits: 0,
    };
    const globalBudget = this.budgets.get(globalKey) ?? {
      spentSubunits: 0,
      reservedSubunits: 0,
    };
    if (
      userBudget.spentSubunits + userBudget.reservedSubunits + amountSubunits >
      userLimitSubunits
    ) {
      throw new StoreError("User spend limit exceeded", "spend-limit-exceeded");
    }
    if (
      globalBudget.spentSubunits +
        globalBudget.reservedSubunits +
        amountSubunits >
      globalLimitSubunits
    ) {
      throw new StoreError(
        "Global spend limit exceeded",
        "spend-limit-exceeded",
      );
    }

    const reservation = UsageReservationSchema.parse({
      id: `reservation:${input.attemptId}`,
      attemptId: input.attemptId,
      idempotencyKey: input.idempotencyKey,
      ownerId: input.ownerId,
      caseId: input.caseId,
      runId: input.runId,
      periodStart: start,
      periodSeconds: input.periodSeconds,
      reservedUsd: amountUsd,
      actualCostUsd: null,
      status: "reserved",
      createdAt: input.at,
      updatedAt: input.at,
      expiresAt: input.expiresAt,
      recoveryCheckedAt: null,
    });
    const entry = UsageLedgerEntrySchema.parse({
      id: input.attemptId,
      attemptId: input.attemptId,
      ownerId: input.ownerId,
      caseId: input.caseId,
      runId: input.runId,
      taskId: input.taskId,
      sourceCaseId: parent.sourceCaseId,
      useCase: parent.useCase,
      provider: input.provider,
      model: input.model,
      settings: input.settings,
      inputAllowanceTokens: input.inputAllowanceTokens,
      outputAllowanceTokens: input.outputAllowanceTokens,
      searchRequested: input.searchRequested,
      price: input.price,
      priceId: input.price.id,
      priceVersion: input.price.version,
      units: unknownUnits,
      outcome: "admitted",
      costUsd: null,
      costStatus: "unknown",
      reservedUsd: amountUsd,
      reservationStatus: "reserved",
      errorCode: null,
      createdAt: input.at,
      updatedAt: input.at,
      settledAt: null,
    });
    this.budgets.set(userKey, {
      ...userBudget,
      reservedSubunits: userBudget.reservedSubunits + amountSubunits,
    });
    this.budgets.set(globalKey, {
      ...globalBudget,
      reservedSubunits: globalBudget.reservedSubunits + amountSubunits,
    });
    this.reservations.set(reservation.id, reservation);
    this.reservationKeys.set(input.idempotencyKey, reservation.id);
    this.ledger.set(entry.id, entry);
    return structuredClone(reservation);
  }

  async settle(input: UsageSettlement): Promise<void> {
    const reservation = this.reservations.get(input.reservation.id);
    if (!reservation || reservation.attemptId !== input.reservation.attemptId) {
      throw new StoreError(
        "Usage reservation was not found",
        "reservation-not-found",
      );
    }
    const entry = this.ledger.get(reservation.attemptId);
    if (!entry) {
      throw new StoreError(
        "Usage attempt was not found",
        "usage-attempt-not-found",
      );
    }
    const estimate = estimateUsageCost(
      input.units,
      entry.price,
      entry.searchRequested,
    );
    const reservedUnknownCost =
      entry.outcome !== "admitted" &&
      entry.costStatus === "unknown" &&
      entry.reservationStatus === "reserved" &&
      reservation.status === "reserved";
    // Unknown-cost attempts keep their reservation, so any of them can be
    // reconciled once verified usage arrives.
    const reconcilable =
      reservedUnknownCost &&
      (entry.outcome === "unknown" || estimate.status === "estimated");
    if (entry.outcome !== "admitted" && !reconcilable) {
      if (
        entry.outcome !== input.outcome ||
        entry.costStatus !== estimate.status ||
        entry.costUsd !== estimate.costUsd ||
        !compareUnits(entry.units, input.units)
      ) {
        throw new StoreError(
          "Usage attempt was already settled with different data",
          "settlement-conflict",
        );
      }
      return;
    }
    if (reservation.status !== "reserved") {
      throw new StoreError(
        "A released usage reservation cannot be settled",
        "invalid-reservation-state",
      );
    }
    const userKey = `user:${reservation.ownerId}:${reservation.periodSeconds}:${reservation.periodStart}`;
    const globalKey = `global:${reservation.periodSeconds}:${reservation.periodStart}`;
    const reservationSubunits = moneySubunits(reservation.reservedUsd);
    const costSubunits =
      estimate.status === "estimated" ? moneySubunits(estimate.costUsd!) : null;
    const costIsKnown = costSubunits !== null;
    const updatedReservation = UsageReservationSchema.parse({
      ...reservation,
      actualCostUsd: costIsKnown ? estimate.costUsd : null,
      status: costIsKnown ? "settled" : "reserved",
      // A recorded outcome no longer needs expiry recovery; funds stay held.
      recoveryCheckedAt: reservation.recoveryCheckedAt ?? input.at,
      updatedAt: input.at,
    });
    const updatedEntry = UsageLedgerEntrySchema.parse({
      ...entry,
      units: input.units,
      outcome: input.outcome,
      costUsd: costIsKnown ? estimate.costUsd : null,
      costStatus: estimate.status,
      reservationStatus: costIsKnown ? "settled" : "reserved",
      errorCode: input.errorCode,
      updatedAt: input.at,
      settledAt: input.at,
    });
    if (estimate.status === "estimated") {
      const affectedBudgets = [
        [userKey, "user"],
        [globalKey, "global"],
      ] as const;
      const currentBudgets = affectedBudgets.map(([key, owner]) => {
        const budget = this.budgets.get(key);
        if (!budget || budget.reservedSubunits < reservationSubunits) {
          throw new StoreError(
            `The ${owner} reservation no longer matches its budget`,
            "reservation-budget-conflict",
          );
        }
        return { key, budget };
      });
      for (const { key, budget } of currentBudgets) {
        this.budgets.set(key, {
          spentSubunits: budget.spentSubunits + costSubunits!,
          reservedSubunits: budget.reservedSubunits - reservationSubunits,
        });
      }
    }

    this.reservations.set(reservation.id, updatedReservation);
    this.ledger.set(entry.id, updatedEntry);
  }

  async release(
    reservationId: string,
    reason: "cancelled" | "failed",
  ): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status === "released") return;
    if (reservation.status !== "reserved") {
      throw new StoreError(
        "Only an unsettled usage reservation can be released",
        "invalid-reservation-state",
      );
    }
    const entry = this.ledger.get(reservation.attemptId);
    if (!entry || entry.outcome !== "admitted") {
      throw new StoreError(
        "Unknown usage exposure must remain reserved",
        "unknown-usage-exposure",
      );
    }
    const userKey = `user:${reservation.ownerId}:${reservation.periodSeconds}:${reservation.periodStart}`;
    const globalKey = `global:${reservation.periodSeconds}:${reservation.periodStart}`;
    for (const key of [userKey, globalKey]) {
      const budget = this.budgets.get(key);
      if (
        !budget ||
        budget.reservedSubunits < moneySubunits(reservation.reservedUsd)
      ) {
        throw new StoreError(
          "The usage reservation no longer matches its budget",
          "reservation-budget-conflict",
        );
      }
    }
    const at = new Date().toISOString();
    const updatedReservation = UsageReservationSchema.parse({
      ...reservation,
      status: "released",
      updatedAt: at,
    });
    const updatedEntry = UsageLedgerEntrySchema.parse({
      ...entry,
      outcome: reason === "cancelled" ? "cancelled" : "failed",
      reservationStatus: "released",
      errorCode: reason,
      updatedAt: at,
      settledAt: at,
    });
    const reservationSubunits = moneySubunits(reservation.reservedUsd);
    for (const key of [userKey, globalKey]) {
      const budget = this.budgets.get(key)!;
      this.budgets.set(key, {
        ...budget,
        reservedSubunits: budget.reservedSubunits - reservationSubunits,
      });
    }
    this.reservations.set(reservation.id, updatedReservation);
    this.ledger.set(entry.id, updatedEntry);
  }

  async list(filter: UsageLedgerFilter = {}): Promise<UsageLedgerEntry[]> {
    const limit = filter.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new StoreError(
        "Usage query limit must be between 1 and 5000",
        "invalid-query-limit",
      );
    }
    const from = filter.from ? Date.parse(filter.from) : undefined;
    const to = filter.to ? Date.parse(filter.to) : undefined;
    if (
      (filter.from && !Number.isFinite(from)) ||
      (filter.to && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    ) {
      throw new StoreError("Invalid usage time range", "invalid-usage-range");
    }
    return [...this.ledger.values()]
      .filter(
        (entry) =>
          (!filter.ownerId || entry.ownerId === filter.ownerId) &&
          (!filter.caseId || entry.caseId === filter.caseId) &&
          (!filter.runId || entry.runId === filter.runId) &&
          (from === undefined || Date.parse(entry.createdAt) >= from) &&
          (to === undefined || Date.parse(entry.createdAt) < to),
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.attemptId.localeCompare(left.attemptId),
      )
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async listForCase(
    ownerId: string,
    caseId: string,
  ): Promise<UsageLedgerEntry[]> {
    return [...this.ledger.values()]
      .filter((entry) => entry.ownerId === ownerId && entry.caseId === caseId)
      .map((entry) => structuredClone(entry));
  }

  async markInterrupted(
    ownerId: string,
    caseId: string,
    runId: string,
    taskId: string,
    at: string,
  ): Promise<void> {
    const timestamp = new Date(at).toISOString();
    for (const [id, entry] of this.ledger) {
      if (
        entry.ownerId === ownerId &&
        entry.caseId === caseId &&
        entry.runId === runId &&
        entry.taskId === taskId &&
        entry.outcome === "admitted"
      ) {
        this.ledger.set(
          id,
          UsageLedgerEntrySchema.parse({
            ...entry,
            outcome: "unknown",
            errorCode: "attempt-interrupted",
            units: unknownUnits,
            costStatus: "unknown",
            costUsd: null,
            updatedAt: timestamp,
            settledAt: timestamp,
          }),
        );
      }
    }
  }

  async listForRun(
    ownerId: string,
    caseId: string,
    runId: string,
  ): Promise<UsageLedgerEntry[]> {
    return [...this.ledger.values()]
      .filter(
        (entry) =>
          entry.ownerId === ownerId &&
          entry.caseId === caseId &&
          entry.runId === runId,
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.attemptId.localeCompare(right.attemptId),
      )
      .map((entry) => structuredClone(entry));
  }

  async recoverExpired(at: string, limit = 100): Promise<number> {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new StoreError(
        "Invalid expiration recovery time",
        "invalid-timestamp",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new StoreError(
        "Usage recovery batch size must be between 1 and 1000",
        "invalid-recovery-limit",
      );
    }
    let recovered = 0;
    for (const [attemptId, entry] of this.ledger) {
      if (entry.outcome !== "admitted") continue;
      const reservation = this.reservations.get(`reservation:${attemptId}`);
      if (
        !reservation ||
        reservation.status !== "reserved" ||
        reservation.recoveryCheckedAt != null ||
        Date.parse(reservation.expiresAt) > atMs
      ) {
        continue;
      }
      if (recovered >= limit) break;
      this.ledger.set(
        entry.id,
        UsageLedgerEntrySchema.parse({
          ...entry,
          outcome: "unknown",
          errorCode: "admission-expired",
          updatedAt: new Date(atMs).toISOString(),
          settledAt: new Date(atMs).toISOString(),
        }),
      );
      this.reservations.set(
        reservation.id,
        UsageReservationSchema.parse({
          ...reservation,
          recoveryCheckedAt: new Date(atMs).toISOString(),
        }),
      );
      recovered += 1;
    }
    return recovered;
  }
}
