import type { UsagePrice, UsageUnits } from "./domain.js";

export interface UsageCostEstimate {
  status: "estimated" | "unknown";
  costUsd: number | null;
}

const USD_SUBUNITS_PER_DOLLAR = 100_000_000;
const TOKEN_RATE_DENOMINATOR = 1_000_000n;

export function usdToSubunits(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("USD values must be finite and non-negative");
  }
  const subunits = Math.round(
    Number(value.toFixed(8)) * USD_SUBUNITS_PER_DOLLAR,
  );
  if (!Number.isSafeInteger(subunits)) {
    throw new Error("USD value exceeds the supported precision range");
  }
  return subunits;
}

export function usdFromSubunits(subunits: number): number {
  if (!Number.isSafeInteger(subunits) || subunits < 0) {
    throw new Error("USD subunits must be a non-negative safe integer");
  }
  return subunits / USD_SUBUNITS_PER_DOLLAR;
}

function rateSubunits(value: number): bigint {
  return BigInt(usdToSubunits(value));
}

function roundUpSubunits(numerator: bigint): number {
  const nonNegative = numerator > 0n ? numerator : 0n;
  const subunits =
    (nonNegative + TOKEN_RATE_DENOMINATOR - 1n) / TOKEN_RATE_DENOMINATOR;
  const result = Number(subunits);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Usage cost exceeds the supported precision range");
  }
  return result;
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
  if (searchRequested) return null;

  const conservativeInputRate = Math.max(
    price.inputUsdPerMillion,
    price.cacheReadUsdPerMillion,
    price.cacheWriteUsdPerMillion,
  );
  const numerator =
    BigInt(inputTokens) * rateSubunits(conservativeInputRate) +
    BigInt(outputTokens) * rateSubunits(price.outputUsdPerMillion);
  return usdFromSubunits(roundUpSubunits(numerator));
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
  if (
    (price.cacheReadUsdPerMillion !== inputRate && cacheRead === null) ||
    (price.cacheWriteUsdPerMillion !== inputRate && cacheWrite === null) ||
    (cacheRead !== null && cacheRead > units.input) ||
    (cacheWrite !== null && cacheWrite > units.input) ||
    (cacheRead !== null &&
      cacheWrite !== null &&
      cacheRead + cacheWrite > units.input)
  ) {
    return { status: "unknown", costUsd: null };
  }
  if (searchRequested || (searchUnits !== null && searchUnits > 0)) {
    return { status: "unknown", costUsd: null };
  }

  let numerator =
    BigInt(units.input) * rateSubunits(inputRate) +
    BigInt(units.output) * rateSubunits(price.outputUsdPerMillion);
  if (cacheRead !== null) {
    numerator +=
      BigInt(cacheRead) *
      (rateSubunits(price.cacheReadUsdPerMillion) - rateSubunits(inputRate));
  }
  if (cacheWrite !== null) {
    numerator +=
      BigInt(cacheWrite) *
      (rateSubunits(price.cacheWriteUsdPerMillion) - rateSubunits(inputRate));
  }
  return {
    status: "estimated",
    costUsd: usdFromSubunits(roundUpSubunits(numerator)),
  };
}
