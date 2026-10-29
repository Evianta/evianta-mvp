import type { UsagePrice, UsageUnits } from "./domain.js";

export interface UsageCostEstimate {
  status: "estimated" | "unknown";
  costUsd: number | null;
}

function roundUpUsd(value: number): number {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

export function estimateUsageAllowance(
  inputTokens: number,
  outputTokens: number,
  searchRequested: boolean,
  price: UsagePrice,
): number | null {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 1 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 1
  ) {
    throw new Error("Usage allowances must be positive safe integers");
  }
  if (searchRequested && price.searchUsdPerRequest === null) return null;

  const conservativeInputRate = Math.max(
    price.inputUsdPerMillion,
    price.cacheReadUsdPerMillion,
    price.cacheWriteUsdPerMillion,
  );
  const cost =
    (inputTokens * conservativeInputRate +
      outputTokens * price.outputUsdPerMillion) /
      1_000_000 +
    (searchRequested ? (price.searchUsdPerRequest ?? 0) : 0);
  return roundUpUsd(cost);
}

export function estimateUsageCost(
  units: UsageUnits,
  price: UsagePrice,
  searchRequested: boolean,
): UsageCostEstimate {
  if (units.input === null || units.output === null) {
    return { status: "unknown", costUsd: null };
  }

  const cacheRead = units.cacheRead ?? null;
  const cacheWrite = units.cacheWrite ?? null;
  const searchUnits = units.search ?? null;
  const inputRate = price.inputUsdPerMillion;
  const cacheRatesDiffer =
    price.cacheReadUsdPerMillion !== inputRate ||
    price.cacheWriteUsdPerMillion !== inputRate;

  if (
    (cacheRatesDiffer && (cacheRead === null || cacheWrite === null)) ||
    (cacheRead !== null &&
      cacheWrite !== null &&
      cacheRead + cacheWrite > units.input)
  ) {
    return { status: "unknown", costUsd: null };
  }
  if (
    (searchUnits === null &&
      searchRequested &&
      price.searchUsdPerRequest !== 0) ||
    (searchUnits !== null &&
      searchUnits > 0 &&
      price.searchUsdPerRequest === null)
  ) {
    return { status: "unknown", costUsd: null };
  }

  let cost =
    (units.input * inputRate + units.output * price.outputUsdPerMillion) /
    1_000_000;
  if (cacheRead !== null) {
    cost +=
      (cacheRead * (price.cacheReadUsdPerMillion - inputRate)) / 1_000_000;
  }
  if (cacheWrite !== null) {
    cost +=
      (cacheWrite * (price.cacheWriteUsdPerMillion - inputRate)) / 1_000_000;
  }
  if (searchUnits !== null && searchUnits > 0) {
    cost += searchUnits * (price.searchUsdPerRequest ?? 0);
  }
  return {
    status: "estimated",
    costUsd: roundUpUsd(Math.max(0, cost)),
  };
}
