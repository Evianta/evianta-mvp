import {
  UsageSummarySchema,
  type UsageLedgerEntry,
  type UsageSummary,
} from "@evianta/core";

export function emptyUsageSummary(): UsageSummary {
  return {
    inputUnits: 0,
    outputUnits: 0,
    totalUnits: 0,
    costUsd: 0,
    costStatus: "estimated",
    reservedUsd: 0,
  };
}

function addUnits(total: number | null, value: number | null | undefined) {
  return total === null || value === null || value === undefined
    ? null
    : total + value;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/**
 * Summarizes ledger attempts. Released reservations carry no charge; any
 * attempt with unknown cost makes the summary unknown while its held
 * reservation stays visible as `reservedUsd` exposure.
 */
export function summarizeUsage(
  entries: readonly UsageLedgerEntry[],
): UsageSummary {
  let inputUnits: number | null = 0;
  let outputUnits: number | null = 0;
  let totalUnits: number | null = 0;
  let costUsd = 0;
  let reservedUsd = 0;
  let unknown = false;
  for (const entry of entries) {
    if (entry.reservationStatus === "reserved") {
      reservedUsd += entry.reservedUsd;
    }
    if (entry.reservationStatus === "released") continue;
    inputUnits = addUnits(inputUnits, entry.units.input);
    outputUnits = addUnits(outputUnits, entry.units.output);
    totalUnits = addUnits(totalUnits, entry.units.total);
    if (entry.costStatus === "unknown" || entry.costUsd === null) {
      unknown = true;
    } else {
      costUsd += entry.costUsd;
    }
  }
  if (
    totalUnits !== null &&
    totalUnits < (inputUnits ?? 0) + (outputUnits ?? 0)
  ) {
    totalUnits = null;
  }
  return UsageSummarySchema.parse({
    inputUnits,
    outputUnits,
    totalUnits,
    costUsd: unknown ? null : roundUsd(costUsd),
    costStatus: unknown ? "unknown" : "estimated",
    reservedUsd: roundUsd(reservedUsd),
  });
}
