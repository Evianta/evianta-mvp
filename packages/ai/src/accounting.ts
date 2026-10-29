import { createHash } from "node:crypto";
import {
  estimateUsageAllowance,
  estimateUsageCost as calculateUsageCost,
} from "@evianta/core";
import type {
  UsageAdmissionPort,
  UsagePrice,
  UsagePriceRepository,
  UsageUnits,
} from "@evianta/core";
import {
  AdmissionRejectedError,
  type CostEstimate,
  type UsageAccounting,
  type UsageAttempt,
} from "./index.js";

export interface UsageBudgetLimits {
  userSpendLimitUsd: number;
  globalSpendLimitUsd: number;
  spendPeriodSeconds: number;
}

export interface AdmittedUsageAccountingOptions {
  admission: UsageAdmissionPort;
  prices: UsagePriceRepository;
  limits: UsageBudgetLimits;
  now?: () => Date;
  reservationTtlSeconds?: number;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function pricingSettingsKey(
  settings: Record<string, string | number | boolean | null>,
): string {
  return createHash("sha256").update(stableValue(settings)).digest("hex");
}

export function estimateUsageCost(
  units: UsageUnits,
  price: UsagePrice,
  searchRequested = false,
): CostEstimate {
  return {
    ...calculateUsageCost(units, price, searchRequested),
    pricingIdentity: `${price.provider}:${price.model}`,
  };
}

export function createAdmittedUsageAccounting(
  options: AdmittedUsageAccountingOptions,
): UsageAccounting {
  const attempts = new Map<
    string,
    {
      reservation: Awaited<ReturnType<UsageAdmissionPort["reserve"]>>;
      price: UsagePrice;
      searchRequested: boolean;
    }
  >();
  const now = options.now ?? (() => new Date());
  const reservationTtlSeconds = options.reservationTtlSeconds ?? 900;

  if (
    !Number.isFinite(options.limits.userSpendLimitUsd) ||
    options.limits.userSpendLimitUsd <= 0 ||
    !Number.isFinite(options.limits.globalSpendLimitUsd) ||
    options.limits.globalSpendLimitUsd <= 0 ||
    !Number.isInteger(options.limits.spendPeriodSeconds) ||
    options.limits.spendPeriodSeconds <= 0 ||
    !Number.isInteger(reservationTtlSeconds) ||
    reservationTtlSeconds <= 0
  ) {
    throw new Error("Usage budgets and reservation expiry must be positive");
  }

  return {
    mode: "admitted",
    async admit(attempt) {
      const { caseId, runId } = attempt.context;
      if (!caseId || !runId) {
        throw new AdmissionRejectedError(
          "Paid model calls require an owned case and run",
        );
      }
      if (
        !Number.isInteger(attempt.maxInputTokens) ||
        attempt.maxInputTokens < 1 ||
        !Number.isInteger(attempt.maxOutputTokens) ||
        attempt.maxOutputTokens < 1
      ) {
        throw new AdmissionRejectedError(
          "Paid model calls require bounded input and output allowances",
        );
      }
      const at = now();
      const settingsKey = pricingSettingsKey(attempt.settings);
      const price = await options.prices.findActive(
        attempt.provider,
        attempt.model,
        settingsKey,
        at.toISOString(),
      );
      if (!price) {
        throw new AdmissionRejectedError(
          `No active price is configured for ${attempt.provider}:${attempt.model}`,
        );
      }
      const amountUsd = estimateUsageAllowance(
        attempt.maxInputTokens,
        attempt.maxOutputTokens,
        attempt.searchRequested,
        price,
      );
      if (amountUsd === null) {
        throw new AdmissionRejectedError(
          "No price is configured for the requested web-search capability",
        );
      }
      const reservation = await options.admission.reserve({
        attemptId: attempt.attemptId,
        idempotencyKey: attempt.attemptId,
        ownerId: attempt.context.userId,
        caseId,
        runId,
        taskId: attempt.context.taskId ?? null,
        provider: attempt.provider,
        model: attempt.model,
        settings: attempt.settings,
        price,
        inputAllowanceTokens: attempt.maxInputTokens,
        outputAllowanceTokens: attempt.maxOutputTokens,
        searchRequested: attempt.searchRequested,
        userSpendLimitUsd: options.limits.userSpendLimitUsd,
        globalSpendLimitUsd: options.limits.globalSpendLimitUsd,
        periodSeconds: options.limits.spendPeriodSeconds,
        at: at.toISOString(),
        expiresAt: new Date(
          at.getTime() + reservationTtlSeconds * 1000,
        ).toISOString(),
      });
      attempts.set(attempt.attemptId, {
        reservation,
        price,
        searchRequested: attempt.searchRequested,
      });
    },
    async record(attempt: UsageAttempt) {
      const admitted = attempts.get(attempt.attemptId);
      if (!admitted) {
        throw new Error(
          `Usage attempt ${attempt.attemptId} has no active reservation`,
        );
      }
      const estimate = estimateUsageCost(
        attempt.units,
        admitted.price,
        admitted.searchRequested,
      );
      await options.admission.settle({
        reservation: admitted.reservation,
        outcome: attempt.outcome,
        units: attempt.units,
        errorCode: attempt.errorCode ?? null,
        at: now().toISOString(),
      });
      attempts.delete(attempt.attemptId);
      return estimate;
    },
  };
}
