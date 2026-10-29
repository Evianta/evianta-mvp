import type { UsagePrice, UsageUnits } from "./domain.js";

export interface UsageCostEstimate {
  status: "estimated" | "unknown";
  costUsd: number | null;
}

const USD_SUBUNITS_PER_DOLLAR = 100_000_000;
const USD_SUBUNITS_PER_TOKEN_PER_RATE = 100n;

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

function decimalParts(value: number): { coefficient: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Usage prices must be finite and non-negative");
  }
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - exponent;
  const coefficient = BigInt(`${whole}${fraction}`);
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale };
}

function roundUpSubunits(numerator: bigint, denominator: bigint): number {
  const nonNegative = numerator > 0n ? numerator : 0n;
  const subunits = (nonNegative + denominator - 1n) / denominator;
  const result = Number(subunits);
  if (!Number.isSafeInteger(result)) {
    throw new Error("Usage cost exceeds the supported precision range");
  }
  return result;
}

function weightedRateNumerator(
  components: Array<{ tokens: number; rate: number; direction?: 1 | -1 }>,
): { numerator: bigint; denominator: bigint } {
  const rates = components.map(({ rate }) => decimalParts(rate));
  const scale = Math.max(...rates.map(({ scale: rateScale }) => rateScale));
  const denominator = 10n ** BigInt(scale);
  const numerator = components.reduce((total, component, index) => {
    const rate = rates[index]!;
    const scaledRate = rate.coefficient * 10n ** BigInt(scale - rate.scale);
    return (
      total +
      BigInt(component.tokens) *
        scaledRate *
        USD_SUBUNITS_PER_TOKEN_PER_RATE *
        BigInt(component.direction ?? 1)
    );
  }, 0n);
  return { numerator, denominator };
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
  const { numerator, denominator } = weightedRateNumerator([
    { tokens: inputTokens, rate: conservativeInputRate },
    { tokens: outputTokens, rate: price.outputUsdPerMillion },
  ]);
  return usdFromSubunits(roundUpSubunits(numerator, denominator));
}

export function estimateUsageCost(
  units: UsageUnits,
  price: UsagePrice,
  searchRequested: boolean,
): UsageCostEstimate {
  if (units.input === null || units.output === null) {
    return { status: "unknown", costUsd: null };
  }
  if (units.total !== null && units.total !== units.input + units.output) {
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

  const components: Array<{
    tokens: number;
    rate: number;
    direction?: 1 | -1;
  }> = [
    { tokens: units.input, rate: inputRate },
    { tokens: units.output, rate: price.outputUsdPerMillion },
  ];
  if (cacheRead !== null) {
    components.push(
      { tokens: cacheRead, rate: price.cacheReadUsdPerMillion },
      { tokens: cacheRead, rate: inputRate, direction: -1 },
    );
  }
  if (cacheWrite !== null) {
    components.push(
      { tokens: cacheWrite, rate: price.cacheWriteUsdPerMillion },
      { tokens: cacheWrite, rate: inputRate, direction: -1 },
    );
  }
  const { numerator, denominator } = weightedRateNumerator(components);
  return {
    status: "estimated",
    costUsd: usdFromSubunits(roundUpSubunits(numerator, denominator)),
  };
}
