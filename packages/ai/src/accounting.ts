import { createHash } from "node:crypto";
import {
  estimateUsageAllowance,
  estimateUsageCost as calculateUsageCost,
} from "@evianta/core";
import type {
  RunAdmissionPort,
  RunAdmissionLease,
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
  runAdmission: RunAdmissionPort;
  prices: UsagePriceRepository;
  limits: UsageBudgetLimits;
  now?: () => Date;
  reservationTtlSeconds?: number;
  runLeaseTtlSeconds?: number;
}

interface ActiveUsageAttempt {
  reservation: Awaited<ReturnType<UsageAdmissionPort["reserve"]>>;
  price: UsagePrice;
  searchRequested: boolean;
  heartbeat: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  leaseExpiresAt: string;
  renewal?: Promise<void>;
  stopped: boolean;
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
  const attempts = new Map<string, ActiveUsageAttempt>();
  const now = options.now ?? (() => new Date());
  const reservationTtlSeconds = options.reservationTtlSeconds ?? 900;
  const runLeaseTtlSeconds = options.runLeaseTtlSeconds ?? 900;

  if (
    !Number.isFinite(options.limits.userSpendLimitUsd) ||
    options.limits.userSpendLimitUsd <= 0 ||
    !Number.isFinite(options.limits.globalSpendLimitUsd) ||
    options.limits.globalSpendLimitUsd <= 0 ||
    !Number.isInteger(options.limits.spendPeriodSeconds) ||
    options.limits.spendPeriodSeconds <= 0 ||
    !Number.isInteger(reservationTtlSeconds) ||
    reservationTtlSeconds <= 0 ||
    !Number.isInteger(runLeaseTtlSeconds) ||
    runLeaseTtlSeconds < 3
  ) {
    throw new Error("Usage budgets and reservation expiry must be positive");
  }
  const heartbeatIntervalMs = Math.max(
    1_000,
    Math.floor((runLeaseTtlSeconds * 1_000) / 3),
  );
  const renewalTimeoutMs = 5_000;

  async function withRenewalDeadline<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new AdmissionRejectedError(
                  "Run lease renewal timed out before provider dispatch",
                ),
              ),
            renewalTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function stopHeartbeat(attempt: ActiveUsageAttempt): Promise<void> {
    attempt.stopped = true;
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
    if (!attempt.renewal) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      attempt.renewal,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, renewalTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  return {
    mode: "admitted",
    async admit(attempt) {
      const { caseId, runId } = attempt.context;
      const { leaseId, fencingToken } = attempt.context;
      if (
        !attempt.context.userId ||
        !caseId ||
        !runId ||
        !leaseId ||
        typeof fencingToken !== "number" ||
        !Number.isSafeInteger(fencingToken) ||
        fencingToken < 1
      ) {
        throw new AdmissionRejectedError(
          "Paid model calls require an owned case and an active fenced run lease",
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
      if (attempts.has(attempt.attemptId)) {
        throw new Error(`Usage attempt ${attempt.attemptId} is already active`);
      }
      const settingsKey = pricingSettingsKey(attempt.settings);
      const lookupAt = now().toISOString();
      const price = await options.prices.findActive(
        attempt.provider,
        attempt.model,
        settingsKey,
        lookupAt,
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
      const admittedAt = now();
      if (!Number.isFinite(admittedAt.getTime())) {
        throw new AdmissionRejectedError(
          "Usage admission requires a valid current time",
        );
      }
      const at = admittedAt.toISOString();
      const reservation = await options.admission.reserve({
        attemptId: attempt.attemptId,
        idempotencyKey: attempt.attemptId,
        ownerId: attempt.context.userId,
        caseId,
        runId,
        leaseId,
        fencingToken,
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
        at,
        expiresAt: new Date(
          admittedAt.getTime() + reservationTtlSeconds * 1000,
        ).toISOString(),
      });
      const leaseRequestBase = {
        ownerId: attempt.context.userId,
        caseId,
        runId,
        leaseId,
        fencingToken,
      };
      const renewLease = async (): Promise<RunAdmissionLease | null> => {
        const renewedAt = now();
        if (!Number.isFinite(renewedAt.getTime())) {
          throw new AdmissionRejectedError(
            "Run lease renewal requires a valid current time",
          );
        }
        const lease = await options.runAdmission.renew({
          ...leaseRequestBase,
          at: renewedAt.toISOString(),
          expiresAt: new Date(
            renewedAt.getTime() + runLeaseTtlSeconds * 1000,
          ).toISOString(),
        });
        return lease;
      };
      let lease: RunAdmissionLease | null;
      try {
        lease = await withRenewalDeadline(renewLease());
      } catch (error) {
        await options.admission.release(reservation.id, "cancelled");
        throw error;
      }
      if (!lease) {
        await options.admission.release(reservation.id, "cancelled");
        throw new AdmissionRejectedError(
          "The run lease expired before provider dispatch",
        );
      }
      const active: ActiveUsageAttempt = {
        reservation,
        price,
        searchRequested: attempt.searchRequested,
        heartbeat: new AbortController(),
        leaseExpiresAt: lease.expiresAt,
        stopped: false,
      };
      const scheduleExpiryGuard = (): void => {
        if (active.expiryTimer) clearTimeout(active.expiryTimer);
        if (active.stopped) return;
        const remainingMs =
          Date.parse(active.leaseExpiresAt) - now().getTime() - 1_000;
        const expire = (): void => {
          active.heartbeat.abort(
            new AdmissionRejectedError(
              "The run lease expired during provider execution",
            ),
          );
        };
        if (!(remainingMs > 0)) {
          expire();
          return;
        }
        active.expiryTimer = setTimeout(expire, remainingMs);
      };
      const scheduleHeartbeat = (): void => {
        active.timer = setTimeout(() => {
          active.renewal = (async () => {
            try {
              const renewedLease = await renewLease();
              if (active.stopped) return;
              if (!renewedLease) {
                active.heartbeat.abort(
                  new AdmissionRejectedError(
                    "The run lease was lost during provider execution",
                  ),
                );
              } else {
                active.leaseExpiresAt = renewedLease.expiresAt;
                scheduleExpiryGuard();
              }
            } catch (error) {
              active.heartbeat.abort(error);
            }
          })().finally(() => {
            active.renewal = undefined;
            if (!active.stopped && !active.heartbeat.signal.aborted) {
              scheduleHeartbeat();
            }
          });
        }, heartbeatIntervalMs);
      };
      scheduleExpiryGuard();
      if (active.heartbeat.signal.aborted) {
        active.stopped = true;
        await options.admission.release(reservation.id, "cancelled");
        throw new AdmissionRejectedError(
          "The run lease expired before provider dispatch",
        );
      }
      attempts.set(attempt.attemptId, active);
      scheduleHeartbeat();
      return active.heartbeat.signal;
    },
    async record(attempt: UsageAttempt) {
      const admitted = attempts.get(attempt.attemptId);
      if (!admitted) {
        throw new Error(
          `Usage attempt ${attempt.attemptId} has no active reservation`,
        );
      }
      await stopHeartbeat(admitted);
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
    async cancel(attemptId: string) {
      const admitted = attempts.get(attemptId);
      if (!admitted) return;
      await stopHeartbeat(admitted);
      await options.admission.release(admitted.reservation.id, "cancelled");
      attempts.delete(attemptId);
    },
  };
}
