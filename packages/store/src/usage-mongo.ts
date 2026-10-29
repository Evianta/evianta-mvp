import {
  CaseSchema,
  UsageLedgerEntrySchema,
  UsagePriceSchema,
  UsageReservationSchema,
  UsageUnitsSchema,
  estimateUsageAllowance,
  estimateUsageCost,
  type UsageAdmissionPort,
  type UsageLedgerFilter,
  type UsageLedgerRepository,
  type UsagePrice,
  type UsagePriceRepository,
  type UsageLedgerEntry,
  type UsageReservation,
  type UsageReservationRequest,
  type UsageSettlement,
  usdToSubunits,
} from "@evianta/core";
import {
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
} from "mongodb";
import { z } from "zod";
import { CaseNotOwnedError, StoreError } from "./errors.js";

type StoredDocument = Document & { _id: string };
const MAX_EXPIRED_RECOVERY_BATCH = 1_000;
const DEFAULT_EXPIRED_RECOVERY_BATCH = 100;
const LEDGER_MIGRATION_BATCH = 500;

const unknownUnits = UsageUnitsSchema.parse({
  input: null,
  output: null,
  total: null,
  reasoning: null,
  cacheRead: null,
  cacheWrite: null,
  search: null,
});
const ReservationRequestSchema = z
  .object({
    attemptId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    ownerId: z.string().min(1),
    caseId: z.string().min(1),
    runId: z.string().min(1),
    leaseId: z.string().min(1),
    fencingToken: z.number().safe().int().positive(),
    taskId: z.string().min(1).nullable(),
    provider: z.string().min(1),
    model: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
    price: UsagePriceSchema,
    inputAllowanceTokens: z.number().safe().int().positive(),
    outputAllowanceTokens: z.number().safe().int().positive(),
    searchRequested: z.boolean(),
    userSpendLimitUsd: z.number().finite().positive(),
    globalSpendLimitUsd: z.number().finite().positive(),
    periodSeconds: z.number().int().positive(),
    at: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (request) => Date.parse(request.expiresAt) > Date.parse(request.at),
    "Reservation expiry must be after admission time",
  );
const SettlementSchema = z.object({
  reservation: UsageReservationSchema,
  outcome: z.enum(["success", "failed", "unknown", "cancelled"]),
  units: UsageUnitsSchema,
  errorCode: z.string().min(1).nullable(),
  at: z.string().datetime({ offset: true }),
});

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function decode<T>(schema: z.ZodType<T>, document: Document | null): T | null {
  if (!document) return null;
  const record = { ...document };
  delete record._id;
  return schema.parse(record);
}

function periodStart(at: string, periodSeconds: number): string {
  const periodMs = periodSeconds * 1000;
  return new Date(
    Math.floor(Date.parse(at) / periodMs) * periodMs,
  ).toISOString();
}

function budgetIdentity(ownerId: string, periodStartAt: string): string {
  return `${ownerId}:${periodStartAt}`;
}

function userBudgetOwner(ownerId: string, periodSeconds: number): string {
  return `user:${ownerId}:${periodSeconds}`;
}

function globalBudgetOwner(periodSeconds: number): string {
  return `global:${periodSeconds}`;
}

function runAdmissionId(ownerId: string, caseId: string): string {
  return JSON.stringify([ownerId, caseId]);
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

function canonicalTimestamp(value: string): string {
  return new Date(Date.parse(value)).toISOString();
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

export class MongoUsageRepository
  implements UsageAdmissionPort, UsagePriceRepository, UsageLedgerRepository
{
  private readonly cases: Collection<StoredDocument>;
  private readonly runs: Collection<StoredDocument>;
  private readonly runAdmissions: Collection<StoredDocument>;
  private readonly prices: Collection<StoredDocument>;
  private readonly ledger: Collection<StoredDocument>;
  private readonly reservations: Collection<StoredDocument>;
  private readonly budgets: Collection<StoredDocument>;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.cases = db.collection<StoredDocument>("cases");
    this.runs = db.collection<StoredDocument>("runs");
    this.runAdmissions = db.collection<StoredDocument>("runAdmissions");
    this.prices = db.collection<StoredDocument>("usagePrices");
    this.ledger = db.collection<StoredDocument>("usageLedger");
    this.reservations = db.collection<StoredDocument>("usageReservations");
    this.budgets = db.collection<StoredDocument>("budgets");
  }

  async initialize(): Promise<void> {
    const legacyBudgets = await this.budgets
      .find({
        $or: [
          { spentSubunits: { $exists: false } },
          { reservedSubunits: { $exists: false } },
        ],
      })
      .toArray();
    for (const budget of legacyBudgets) {
      const updates: Document = {};
      if (budget.spentSubunits === undefined) {
        updates.spentSubunits = moneySubunits(Number(budget.spentUsd ?? 0));
      }
      if (budget.reservedSubunits === undefined) {
        updates.reservedSubunits = moneySubunits(
          Number(budget.reservedUsd ?? 0),
        );
      }
      await this.budgets.updateOne(
        {
          _id: budget._id,
          ...(budget.spentSubunits === undefined
            ? { spentSubunits: { $exists: false } }
            : {}),
          ...(budget.reservedSubunits === undefined
            ? { reservedSubunits: { $exists: false } }
            : {}),
        },
        { $set: updates },
      );
    }
    await this.backfillLedgerInstants();
    await Promise.all([
      this.prices.createIndex(
        { provider: 1, model: 1, settingsKey: 1, version: 1 },
        { unique: true },
      ),
      this.prices.createIndex({
        provider: 1,
        model: 1,
        settingsKey: 1,
        effectiveAt: -1,
      }),
      this.ledger.createIndex({ attemptId: 1 }, { unique: true }),
      this.ledger.createIndex({
        ownerId: 1,
        createdAtInstant: -1,
        attemptId: -1,
      }),
      this.ledger.createIndex({ createdAtInstant: -1, attemptId: -1 }),
      this.ledger.createIndex({
        ownerId: 1,
        caseId: 1,
        runId: 1,
        createdAtInstant: 1,
        attemptId: 1,
      }),
      this.reservations.createIndex({
        status: 1,
        recoveryCheckedAt: 1,
        expiresAt: 1,
      }),
    ]);
  }

  async findActive(
    provider: string,
    model: string,
    settingsKey: string,
    at: string,
  ): Promise<UsagePrice | null> {
    return decode(
      UsagePriceSchema,
      await this.prices
        .aggregate([
          { $match: { provider, model, settingsKey } },
          { $set: { effectiveAtInstant: { $toDate: "$effectiveAt" } } },
          { $match: { effectiveAtInstant: { $lte: new Date(at) } } },
          { $sort: { effectiveAtInstant: -1, version: -1 } },
          { $limit: 1 },
          { $unset: "effectiveAtInstant" },
        ])
        .next(),
    );
  }

  async insert(price: UsagePrice): Promise<void> {
    const parsed = UsagePriceSchema.parse({
      ...price,
      effectiveAt: canonicalTimestamp(price.effectiveAt),
    });
    try {
      await this.prices.insertOne({ ...parsed, _id: parsed.id });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new StoreError(
          "A price with this provider, model, settings, and version already exists",
          "duplicate-price",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async reserve(input: UsageReservationRequest): Promise<UsageReservation> {
    const parsedRequest = ReservationRequestSchema.parse(input);
    const request = {
      ...parsedRequest,
      at: canonicalTimestamp(parsedRequest.at),
      expiresAt: canonicalTimestamp(parsedRequest.expiresAt),
      price: {
        ...parsedRequest.price,
        effectiveAt: canonicalTimestamp(parsedRequest.price.effectiveAt),
      },
    };
    if (
      request.price.provider !== request.provider ||
      request.price.model !== request.model
    ) {
      throw new StoreError(
        "Usage price does not match the admitted model",
        "price-model-mismatch",
      );
    }
    const amountUsd = estimateUsageAllowance(
      request.inputAllowanceTokens,
      request.outputAllowanceTokens,
      request.searchRequested,
      request.price,
    );
    if (amountUsd === null) {
      throw new StoreError(
        "The requested capability has no bounded usage allowance",
        "unbounded-capability",
      );
    }
    const amountSubunits = moneySubunits(amountUsd);
    const userLimitSubunits = moneySubunits(request.userSpendLimitUsd);
    const globalLimitSubunits = moneySubunits(request.globalSpendLimitUsd);
    const start = periodStart(request.at, request.periodSeconds);
    const reservationId = `reservation:${request.attemptId}`;
    const userOwner = userBudgetOwner(request.ownerId, request.periodSeconds);
    const globalOwner = globalBudgetOwner(request.periodSeconds);

    try {
      return await this.withTransaction(async (session) => {
        const existing = decode(
          UsageReservationSchema,
          await this.reservations.findOne(
            { idempotencyKey: request.idempotencyKey },
            { session },
          ),
        );
        if (existing) {
          this.assertSameReservation(existing, request);
          const entry = decode(
            UsageLedgerEntrySchema,
            await this.ledger.findOne(
              { attemptId: existing.attemptId },
              { session },
            ),
          );
          if (
            !entry ||
            entry.provider !== request.provider ||
            entry.model !== request.model ||
            entry.priceId !== request.price.id ||
            entry.priceVersion !== request.price.version ||
            entry.inputAllowanceTokens !== request.inputAllowanceTokens ||
            entry.outputAllowanceTokens !== request.outputAllowanceTokens ||
            entry.searchRequested !== request.searchRequested ||
            canonicalJson(entry.price) !== canonicalJson(request.price) ||
            canonicalJson(entry.settings) !== canonicalJson(request.settings)
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

        const parent = decode(
          CaseSchema,
          await this.cases.findOne(
            {
              _id: request.caseId,
              ownerId: request.ownerId,
              isSample: false,
              status: { $ne: "deleted" },
            },
            { session },
          ),
        );
        if (!parent) throw new CaseNotOwnedError();
        const storedPrice = decode(
          UsagePriceSchema,
          await this.prices
            .aggregate(
              [
                {
                  $match: {
                    provider: request.provider,
                    model: request.model,
                    settingsKey: request.price.settingsKey,
                  },
                },
                {
                  $set: { effectiveAtInstant: { $toDate: "$effectiveAt" } },
                },
                {
                  $match: {
                    effectiveAtInstant: { $lte: new Date(request.at) },
                  },
                },
                { $sort: { effectiveAtInstant: -1, version: -1 } },
                { $limit: 1 },
                { $unset: "effectiveAtInstant" },
              ],
              { session },
            )
            .next(),
        );
        const activePrice = storedPrice && {
          ...storedPrice,
          effectiveAt: canonicalTimestamp(storedPrice.effectiveAt),
        };
        if (
          !activePrice ||
          canonicalJson(activePrice) !== canonicalJson(request.price) ||
          canonicalJson(activePrice.settings) !==
            canonicalJson(request.settings) ||
          canonicalJson(request.price.settings) !==
            canonicalJson(request.settings)
        ) {
          throw new StoreError(
            "The admitted model price is not the active version for these settings",
            "price-not-active",
          );
        }
        const run = await this.runs.findOne(
          {
            _id: request.runId,
            ownerId: request.ownerId,
            caseId: request.caseId,
            status: "running",
            leaseId: request.leaseId,
            fencingToken: request.fencingToken,
            cancellationRequested: false,
            $expr: {
              $gt: [{ $toDate: "$leaseExpiresAt" }, new Date(request.at)],
            },
          },
          { session },
        );
        const admission = await this.runAdmissions.findOne(
          {
            _id: runAdmissionId(request.ownerId, request.caseId),
            runId: request.runId,
            state: "active",
            leaseId: request.leaseId,
            fencingToken: request.fencingToken,
            $expr: {
              $gt: [{ $toDate: "$leaseExpiresAt" }, new Date(request.at)],
            },
          },
          { session },
        );
        if (!run || !admission) {
          throw new StoreError(
            "Usage admission requires the run's active fenced lease",
            "run-admission-required",
          );
        }
        const fencedAdmission = await this.runAdmissions.updateOne(
          {
            _id: runAdmissionId(request.ownerId, request.caseId),
            runId: request.runId,
            state: "active",
            leaseId: request.leaseId,
            fencingToken: request.fencingToken,
            leaseExpiresAt: admission.leaseExpiresAt,
            $expr: {
              $gt: [{ $toDate: "$leaseExpiresAt" }, new Date(request.at)],
            },
          },
          { $inc: { usageReservationFence: 1 } },
          { session },
        );
        if (fencedAdmission.matchedCount !== 1) {
          throw new StoreError(
            "The run admission changed during usage reservation",
            "run-admission-required",
          );
        }

        await this.ensureBudget(userOwner, start, request.at, session);
        await this.ensureBudget(globalOwner, start, request.at, session);
        await this.increaseReservedBudget(
          userOwner,
          start,
          userLimitSubunits,
          amountSubunits,
          session,
        );
        await this.increaseReservedBudget(
          globalOwner,
          start,
          globalLimitSubunits,
          amountSubunits,
          session,
        );

        const reservation = UsageReservationSchema.parse({
          id: reservationId,
          attemptId: request.attemptId,
          idempotencyKey: request.idempotencyKey,
          ownerId: request.ownerId,
          caseId: request.caseId,
          runId: request.runId,
          periodStart: start,
          periodSeconds: request.periodSeconds,
          reservedUsd: amountUsd,
          actualCostUsd: null,
          status: "reserved",
          createdAt: request.at,
          updatedAt: request.at,
          expiresAt: request.expiresAt,
          recoveryCheckedAt: null,
        });
        const entry = UsageLedgerEntrySchema.parse({
          id: request.attemptId,
          attemptId: request.attemptId,
          ownerId: request.ownerId,
          caseId: request.caseId,
          runId: request.runId,
          taskId: request.taskId,
          sourceCaseId: parent.sourceCaseId,
          useCase: parent.useCase,
          provider: request.provider,
          model: request.model,
          settings: request.settings,
          inputAllowanceTokens: request.inputAllowanceTokens,
          outputAllowanceTokens: request.outputAllowanceTokens,
          searchRequested: request.searchRequested,
          price: request.price,
          priceId: request.price.id,
          priceVersion: request.price.version,
          units: unknownUnits,
          outcome: "admitted",
          costUsd: null,
          costStatus: "unknown",
          reservedUsd: amountUsd,
          reservationStatus: "reserved",
          errorCode: null,
          createdAt: request.at,
          updatedAt: request.at,
          settledAt: null,
        });
        await this.reservations.insertOne(
          { ...reservation, _id: reservation.id },
          { session },
        );
        await this.ledger.insertOne(
          {
            ...entry,
            _id: entry.id,
            createdAtInstant: new Date(Date.parse(entry.createdAt)),
          },
          { session },
        );
        return reservation;
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = decode(
          UsageReservationSchema,
          await this.reservations.findOne({
            idempotencyKey: request.idempotencyKey,
          }),
        );
        if (existing) {
          this.assertSameReservation(existing, request);
          throw new StoreError(
            "This usage attempt was already admitted and cannot be dispatched again",
            "usage-attempt-exists",
          );
        }
        throw new StoreError(
          "A usage attempt with this identity already exists",
          "duplicate-usage-attempt",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async settle(input: UsageSettlement): Promise<void> {
    const parsedSettlement = SettlementSchema.parse(input);
    const settlement = {
      ...parsedSettlement,
      at: canonicalTimestamp(parsedSettlement.at),
    };
    await this.withTransaction(async (session) => {
      const reservation = decode(
        UsageReservationSchema,
        await this.reservations.findOne(
          { _id: settlement.reservation.id },
          { session },
        ),
      );
      if (
        !reservation ||
        reservation.attemptId !== settlement.reservation.attemptId
      ) {
        throw new StoreError(
          "Usage reservation was not found",
          "reservation-not-found",
        );
      }
      const entry = decode(
        UsageLedgerEntrySchema,
        await this.ledger.findOne(
          { attemptId: reservation.attemptId },
          { session },
        ),
      );
      if (!entry) {
        throw new StoreError(
          "Usage attempt was not found",
          "usage-attempt-not-found",
        );
      }

      const estimate = estimateUsageCost(
        settlement.units,
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
        this.assertSameSettlement(entry, settlement);
        return;
      }
      if (reservation.status !== "reserved") {
        throw new StoreError(
          "A released usage reservation cannot be settled",
          "invalid-reservation-state",
        );
      }

      const costIsKnown = estimate.status === "estimated";
      const reservationSubunits = moneySubunits(reservation.reservedUsd);
      const costSubunits = costIsKnown
        ? moneySubunits(estimate.costUsd!)
        : null;
      const updatedReservation = UsageReservationSchema.parse({
        ...reservation,
        actualCostUsd: costIsKnown ? estimate.costUsd : null,
        status: costIsKnown ? "settled" : "reserved",
        // A recorded outcome no longer needs expiry recovery; funds stay held.
        recoveryCheckedAt: reservation.recoveryCheckedAt ?? settlement.at,
        updatedAt: settlement.at,
      });
      const updatedEntry = UsageLedgerEntrySchema.parse({
        ...entry,
        units: settlement.units,
        outcome: settlement.outcome,
        costUsd: costIsKnown ? estimate.costUsd : null,
        costStatus: estimate.status,
        reservationStatus: costIsKnown ? "settled" : "reserved",
        errorCode: settlement.errorCode,
        updatedAt: settlement.at,
        settledAt: settlement.at,
      });
      if (costIsKnown) {
        await this.consumeReservedBudget(
          userBudgetOwner(reservation.ownerId, reservation.periodSeconds),
          reservation.periodStart,
          reservationSubunits,
          costSubunits!,
          settlement.at,
          session,
        );
        await this.consumeReservedBudget(
          globalBudgetOwner(reservation.periodSeconds),
          reservation.periodStart,
          reservationSubunits,
          costSubunits!,
          settlement.at,
          session,
        );
      }

      const reservationResult = await this.reservations.replaceOne(
        { _id: reservation.id, status: "reserved" },
        { ...updatedReservation, _id: reservation.id },
        { session },
      );
      const ledgerResult = await this.ledger.replaceOne(
        { _id: entry.id },
        {
          ...updatedEntry,
          _id: entry.id,
          createdAtInstant: new Date(Date.parse(updatedEntry.createdAt)),
        },
        { session },
      );
      if (
        reservationResult.matchedCount !== 1 ||
        ledgerResult.matchedCount !== 1
      ) {
        throw new StoreError(
          "Usage settlement changed during update",
          "settlement-conflict",
        );
      }
    });
  }

  async release(
    reservationId: string,
    reason: "cancelled" | "failed",
  ): Promise<void> {
    await this.withTransaction(async (session) => {
      const reservation = decode(
        UsageReservationSchema,
        await this.reservations.findOne({ _id: reservationId }, { session }),
      );
      if (!reservation || reservation.status === "released") return;
      if (reservation.status !== "reserved") {
        throw new StoreError(
          "Only an unsettled usage reservation can be released",
          "invalid-reservation-state",
        );
      }
      const entry = decode(
        UsageLedgerEntrySchema,
        await this.ledger.findOne(
          { attemptId: reservation.attemptId },
          { session },
        ),
      );
      if (!entry || entry.outcome !== "admitted") {
        throw new StoreError(
          "Unknown usage exposure must remain reserved",
          "unknown-usage-exposure",
        );
      }
      const at = new Date().toISOString();
      await this.decreaseReservedBudget(
        userBudgetOwner(reservation.ownerId, reservation.periodSeconds),
        reservation,
        at,
        session,
      );
      await this.decreaseReservedBudget(
        globalBudgetOwner(reservation.periodSeconds),
        reservation,
        at,
        session,
      );
      await this.reservations.updateOne(
        { _id: reservation.id, status: "reserved" },
        { $set: { status: "released", updatedAt: at } },
        { session },
      );
      await this.ledger.updateOne(
        { _id: entry.id, outcome: "admitted" },
        {
          $set: {
            outcome: reason === "cancelled" ? "cancelled" : "failed",
            reservationStatus: "released",
            errorCode: reason,
            updatedAt: at,
            settledAt: at,
          },
        },
        { session },
      );
    });
  }

  async list(filter: UsageLedgerFilter = {}) {
    const query: Document = {};
    if (filter.ownerId) query.ownerId = filter.ownerId;
    if (filter.caseId) query.caseId = filter.caseId;
    if (filter.runId) query.runId = filter.runId;
    const from = filter.from ? Date.parse(filter.from) : undefined;
    const to = filter.to ? Date.parse(filter.to) : undefined;
    if (
      (filter.from && !Number.isFinite(from)) ||
      (filter.to && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    ) {
      throw new StoreError("Invalid usage time range", "invalid-usage-range");
    }
    const limit = filter.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new StoreError(
        "Usage query limit must be between 1 and 5000",
        "invalid-query-limit",
      );
    }
    const pipeline: Document[] = [{ $match: query }];
    if (from !== undefined || to !== undefined) {
      pipeline.push({
        $match: {
          createdAtInstant: {
            ...(from !== undefined ? { $gte: new Date(from) } : {}),
            ...(to !== undefined ? { $lt: new Date(to) } : {}),
          },
        },
      });
    }
    pipeline.push(
      { $sort: { createdAtInstant: -1, attemptId: -1 } },
      { $limit: limit },
      { $unset: "createdAtInstant" },
    );
    return (await this.ledger.aggregate(pipeline).toArray()).map(
      (record) => decode(UsageLedgerEntrySchema, record)!,
    );
  }

  async listForCase(
    ownerId: string,
    caseId: string,
  ): Promise<UsageLedgerEntry[]> {
    const records = await this.ledger.find({ ownerId, caseId }).toArray();
    return records.map((record) => decode(UsageLedgerEntrySchema, record)!);
  }

  async markInterrupted(
    ownerId: string,
    caseId: string,
    runId: string,
    taskId: string,
    at: string,
  ): Promise<void> {
    const timestamp = canonicalTimestamp(at);
    await this.ledger.updateMany(
      { ownerId, caseId, runId, taskId, outcome: "admitted" },
      {
        $set: {
          outcome: "unknown",
          errorCode: "attempt-interrupted",
          units: unknownUnits,
          costStatus: "unknown",
          costUsd: null,
          updatedAt: timestamp,
          settledAt: timestamp,
        },
      },
    );
  }

  async listForRun(
    ownerId: string,
    caseId: string,
    runId: string,
  ): Promise<UsageLedgerEntry[]> {
    const records = await this.ledger
      .find({ ownerId, caseId, runId })
      .sort({ createdAtInstant: 1, attemptId: 1 })
      .toArray();
    return records.map((record) => decode(UsageLedgerEntrySchema, record)!);
  }

  async recoverExpired(
    at: string,
    limit = DEFAULT_EXPIRED_RECOVERY_BATCH,
  ): Promise<number> {
    const recoveryAt = canonicalTimestamp(at);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_EXPIRED_RECOVERY_BATCH
    ) {
      throw new StoreError(
        "Usage recovery batch size must be between 1 and 1000",
        "invalid-recovery-limit",
      );
    }
    return this.withTransaction(async (session) => {
      const expired = await this.reservations
        .find(
          {
            status: "reserved",
            recoveryCheckedAt: null,
            expiresAt: { $lte: recoveryAt },
          },
          { session },
        )
        .sort({ expiresAt: 1, _id: 1 })
        .limit(limit)
        .toArray();
      let recovered = 0;
      for (const document of expired) {
        const reservation = decode(UsageReservationSchema, document);
        if (!reservation) continue;
        await this.ledger.updateOne(
          { attemptId: reservation.attemptId, outcome: "admitted" },
          {
            $set: {
              outcome: "unknown",
              errorCode: "admission-expired",
              updatedAt: recoveryAt,
              settledAt: recoveryAt,
            },
          },
          { session },
        );
        const result = await this.reservations.updateOne(
          {
            _id: reservation.id,
            status: "reserved",
            recoveryCheckedAt: null,
            expiresAt: { $lte: recoveryAt },
          },
          {
            $set: {
              recoveryCheckedAt: recoveryAt,
              updatedAt: recoveryAt,
            },
          },
          { session },
        );
        recovered += result.matchedCount;
      }
      return recovered;
    });
  }

  private async backfillLedgerInstants(): Promise<void> {
    while (true) {
      const batch = await this.ledger
        .find({ createdAtInstant: { $exists: false } })
        .project({ createdAt: 1 })
        .sort({ _id: 1 })
        .limit(LEDGER_MIGRATION_BATCH)
        .toArray();
      if (batch.length === 0) return;
      const updates = batch.map((record) => {
        const createdAt = Date.parse(String(record.createdAt));
        if (!Number.isFinite(createdAt)) {
          throw new StoreError(
            "Cannot migrate a usage entry with an invalid creation time",
            "invalid-usage-timestamp",
          );
        }
        return {
          updateOne: {
            filter: {
              _id: record._id,
              createdAtInstant: { $exists: false },
            },
            update: { $set: { createdAtInstant: new Date(createdAt) } },
          },
        };
      });
      await this.ledger.bulkWrite(updates, { ordered: false });
    }
  }

  private async ensureBudget(
    ownerId: string,
    period: string,
    at: string,
    session: ClientSession,
  ): Promise<void> {
    const id = budgetIdentity(ownerId, period);
    await this.budgets.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          ownerId,
          periodStart: period,
          spentSubunits: 0,
          reservedSubunits: 0,
          updatedAt: at,
        },
      },
      { upsert: true, session },
    );
  }

  private async increaseReservedBudget(
    ownerId: string,
    period: string,
    limitSubunits: number,
    amountSubunits: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.budgets.updateOne(
      {
        _id: budgetIdentity(ownerId, period),
        $expr: {
          $lte: [
            {
              $add: [
                { $ifNull: ["$spentSubunits", 0] },
                { $ifNull: ["$reservedSubunits", 0] },
              ],
            },
            limitSubunits - amountSubunits,
          ],
        },
      },
      { $inc: { reservedSubunits: amountSubunits } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new StoreError(
        `${ownerId.startsWith("global:") ? "Global" : "User"} spend limit exceeded`,
        "spend-limit-exceeded",
      );
    }
  }

  private async consumeReservedBudget(
    ownerId: string,
    periodStart: string,
    reservationSubunits: number,
    costSubunits: number,
    at: string,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.budgets.updateOne(
      {
        _id: budgetIdentity(ownerId, periodStart),
        reservedSubunits: { $gte: reservationSubunits },
      },
      {
        $inc: {
          reservedSubunits: -reservationSubunits,
          spentSubunits: costSubunits,
        },
        $set: { updatedAt: at },
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new StoreError(
        "The usage reservation no longer matches its budget",
        "reservation-budget-conflict",
      );
    }
  }

  private async decreaseReservedBudget(
    ownerId: string,
    reservation: UsageReservation,
    at: string,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.budgets.updateOne(
      {
        _id: budgetIdentity(ownerId, reservation.periodStart),
        reservedSubunits: {
          $gte: moneySubunits(reservation.reservedUsd),
        },
      },
      {
        $inc: {
          reservedSubunits: -moneySubunits(reservation.reservedUsd),
        },
        $set: { updatedAt: at },
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new StoreError(
        "The usage reservation no longer matches its budget",
        "reservation-budget-conflict",
      );
    }
  }

  private assertSameReservation(
    existing: UsageReservation,
    request: z.infer<typeof ReservationRequestSchema>,
  ): void {
    const amountUsd = estimateUsageAllowance(
      request.inputAllowanceTokens,
      request.outputAllowanceTokens,
      request.searchRequested,
      request.price,
    );
    if (
      existing.attemptId !== request.attemptId ||
      existing.ownerId !== request.ownerId ||
      existing.caseId !== request.caseId ||
      existing.runId !== request.runId ||
      existing.periodSeconds !== request.periodSeconds ||
      existing.reservedUsd !== amountUsd
    ) {
      throw new StoreError(
        "Usage idempotency key was reused with different request data",
        "idempotency-conflict",
      );
    }
  }

  private assertSameSettlement(
    entry: UsageLedgerEntry,
    settlement: z.infer<typeof SettlementSchema>,
  ): void {
    if (
      entry.outcome !== settlement.outcome ||
      entry.costStatus !==
        estimateUsageCost(settlement.units, entry.price, entry.searchRequested)
          .status ||
      entry.costUsd !==
        estimateUsageCost(settlement.units, entry.price, entry.searchRequested)
          .costUsd ||
      JSON.stringify(entry.units) !== JSON.stringify(settlement.units)
    ) {
      throw new StoreError(
        "Usage attempt was already settled with different data",
        "settlement-conflict",
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
