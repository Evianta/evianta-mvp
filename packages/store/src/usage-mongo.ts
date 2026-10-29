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

export class MongoUsageRepository
  implements UsageAdmissionPort, UsagePriceRepository, UsageLedgerRepository
{
  private readonly cases: Collection<Document>;
  private readonly runs: Collection<Document>;
  private readonly prices: Collection<Document>;
  private readonly ledger: Collection<Document>;
  private readonly reservations: Collection<Document>;
  private readonly budgets: Collection<Document>;

  constructor(
    private readonly client: MongoClient,
    db: Db,
  ) {
    this.cases = db.collection("cases");
    this.runs = db.collection("runs");
    this.prices = db.collection("usagePrices");
    this.ledger = db.collection("usageLedger");
    this.reservations = db.collection("usageReservations");
    this.budgets = db.collection("budgets");
  }

  async initialize(): Promise<void> {
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
      this.ledger.createIndex({ ownerId: 1, createdAt: -1 }),
      this.ledger.createIndex({ ownerId: 1, runId: 1, createdAt: 1 }),
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
        .find({
          provider,
          model,
          settingsKey,
          effectiveAt: { $lte: at },
        })
        .sort({ effectiveAt: -1, version: -1 })
        .limit(1)
        .next(),
    );
  }

  async insert(price: UsagePrice): Promise<void> {
    const parsed = UsagePriceSchema.parse(price);
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
    const request = ReservationRequestSchema.parse(input);
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
        "No price is configured for the requested web-search capability",
        "unpriced-capability",
      );
    }
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
        const activePrice = decode(
          UsagePriceSchema,
          await this.prices
            .find(
              {
                provider: request.provider,
                model: request.model,
                settingsKey: request.price.settingsKey,
                effectiveAt: { $lte: request.at },
              },
              { session },
            )
            .sort({ effectiveAt: -1, version: -1 })
            .limit(1)
            .next(),
        );
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
            cancellationRequested: false,
          },
          { session },
        );
        if (!run) {
          throw new StoreError(
            "The run does not belong to this case and owner",
            "run-not-owned",
          );
        }

        await this.ensureBudget(userOwner, start, request.at, session);
        await this.ensureBudget(globalOwner, start, request.at, session);
        await this.increaseReservedBudget(
          userOwner,
          start,
          request.userSpendLimitUsd,
          amountUsd,
          session,
        );
        await this.increaseReservedBudget(
          globalOwner,
          start,
          request.globalSpendLimitUsd,
          amountUsd,
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
        await this.ledger.insertOne({ ...entry, _id: entry.id }, { session });
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
    const settlement = SettlementSchema.parse(input);
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

      if (entry.outcome !== "admitted") {
        this.assertSameSettlement(entry, settlement);
        return;
      }
      if (reservation.status !== "reserved") {
        throw new StoreError(
          "A released usage reservation cannot be settled",
          "invalid-reservation-state",
        );
      }

      const estimate = estimateUsageCost(
        settlement.units,
        entry.price,
        entry.searchRequested,
      );
      const costIsKnown = estimate.status === "estimated";
      if (costIsKnown) {
        await this.consumeReservedBudget(
          userBudgetOwner(reservation.ownerId, reservation.periodSeconds),
          reservation,
          estimate.costUsd!,
          settlement.at,
          session,
        );
        await this.consumeReservedBudget(
          globalBudgetOwner(reservation.periodSeconds),
          reservation,
          estimate.costUsd!,
          settlement.at,
          session,
        );
      }

      const updatedReservation = {
        ...reservation,
        actualCostUsd: costIsKnown ? estimate.costUsd : null,
        status: costIsKnown ? "settled" : "reserved",
        updatedAt: settlement.at,
      };
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
      await this.reservations.replaceOne(
        { _id: reservation.id, status: "reserved" },
        { ...updatedReservation, _id: reservation.id },
        { session },
      );
      await this.ledger.replaceOne(
        { _id: entry.id },
        { ...updatedEntry, _id: entry.id },
        { session },
      );
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
    if (filter.from || filter.to) {
      query.createdAt = {
        ...(from !== undefined ? { $gte: new Date(from).toISOString() } : {}),
        ...(to !== undefined ? { $lt: new Date(to).toISOString() } : {}),
      };
    }
    const limit = filter.limit ?? 500;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new StoreError(
        "Usage query limit must be between 1 and 5000",
        "invalid-query-limit",
      );
    }
    return (
      await this.ledger
        .find(query)
        .sort({ createdAt: -1, attemptId: -1 })
        .limit(limit)
        .toArray()
    ).map((record) => decode(UsageLedgerEntrySchema, record)!);
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
          spentUsd: 0,
          reservedUsd: 0,
          updatedAt: at,
        },
      },
      { upsert: true, session },
    );
  }

  private async increaseReservedBudget(
    ownerId: string,
    period: string,
    limitUsd: number,
    amountUsd: number,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.budgets.updateOne(
      {
        _id: budgetIdentity(ownerId, period),
        $expr: {
          $lte: [
            {
              $add: [
                { $ifNull: ["$spentUsd", 0] },
                { $ifNull: ["$reservedUsd", 0] },
              ],
            },
            limitUsd - amountUsd,
          ],
        },
      },
      { $inc: { reservedUsd: amountUsd } },
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
    reservation: UsageReservation,
    costUsd: number,
    at: string,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.budgets.updateOne(
      {
        _id: budgetIdentity(ownerId, reservation.periodStart),
        reservedUsd: { $gte: reservation.reservedUsd },
      },
      {
        $inc: {
          reservedUsd: -reservation.reservedUsd,
          spentUsd: costUsd,
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
        reservedUsd: { $gte: reservation.reservedUsd },
      },
      {
        $inc: { reservedUsd: -reservation.reservedUsd },
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
