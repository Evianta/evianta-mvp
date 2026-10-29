import type {
  Principal,
  UseCase,
  UsageLedgerEntry,
  UsageLedgerFilter,
  UsageLedgerRepository,
} from "@evianta/core";
import { StoreError } from "./errors.js";

export interface UsageAdminTotals {
  attempts: number;
  knownChargesUsd: number;
  unknownExposureUsd: number;
  reservedUsd: number;
}

export interface UsageAdminSummary {
  entries: UsageLedgerEntry[];
  totals: UsageAdminTotals;
  byUseCase: Record<UseCase, UsageAdminTotals>;
  truncated: boolean;
}

function emptyTotals(): UsageAdminTotals {
  return {
    attempts: 0,
    knownChargesUsd: 0,
    unknownExposureUsd: 0,
    reservedUsd: 0,
  };
}

function addEntry(totals: UsageAdminTotals, entry: UsageLedgerEntry): void {
  totals.attempts += 1;
  if (entry.reservationStatus === "settled" && entry.costUsd !== null) {
    totals.knownChargesUsd += entry.costUsd;
  }
  if (entry.reservationStatus === "reserved") {
    totals.reservedUsd += entry.reservedUsd;
    totals.unknownExposureUsd += entry.reservedUsd;
  }
}

export class UsageAdminService {
  constructor(private readonly ledger: UsageLedgerRepository) {}

  async query(
    principal: Principal,
    filter: UsageLedgerFilter = {},
  ): Promise<UsageAdminSummary> {
    if (principal.role !== "admin") {
      throw new StoreError(
        "Administrator access is required to query usage accounting",
        "admin-required",
      );
    }
    await this.ledger.recoverExpired(new Date().toISOString());
    const limit = filter.limit ?? 500;
    const entries = await this.ledger.list({ ...filter, limit });
    const totals = emptyTotals();
    const byUseCase: Record<UseCase, UsageAdminTotals> = {
      "data-analysis": emptyTotals(),
      "tax-notice": emptyTotals(),
      "msme-payment": emptyTotals(),
    };
    for (const entry of entries) {
      addEntry(totals, entry);
      addEntry(byUseCase[entry.useCase], entry);
    }
    return {
      entries,
      totals,
      byUseCase,
      truncated: entries.length === limit,
    };
  }
}
