import type {
  UsageAdmissionPort,
  UsagePrice,
  UsagePriceRepository,
  UsageReservation,
  RunAdmissionPort,
} from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import {
  AdmissionRejectedError,
  createAdmittedUsageAccounting,
  estimateUsageCost,
  pricingSettingsKey,
  type UsageAttempt,
} from "../src/index.js";

const settings = { maxOutputTokens: 200 };
const settingsKey = pricingSettingsKey(settings);
const price: UsagePrice = {
  id: "price-1",
  provider: "muse",
  model: "spark",
  settingsKey,
  settings,
  currency: "USD",
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  cacheReadUsdPerMillion: 0.5,
  cacheWriteUsdPerMillion: 1,
  searchUsdPerRequest: 0.01,
  version: 1,
  source: "operator",
  effectiveAt: "2026-01-01T00:00:00.000Z",
};

function setup(
  priceRecord: UsagePrice | null = price,
  now: () => Date = () => new Date("2026-06-01T12:00:00.000Z"),
  runLeaseTtlSeconds = 900,
) {
  const reservation: UsageReservation = {
    id: "reservation:attempt-1",
    attemptId: "attempt-1",
    idempotencyKey: "attempt-1",
    ownerId: "user-1",
    caseId: "case-1",
    runId: "run-1",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodSeconds: 86_400,
    reservedUsd: 1,
    actualCostUsd: null,
    status: "reserved",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    expiresAt: "2026-06-01T12:15:00.000Z",
  };
  const admission: UsageAdmissionPort = {
    reserve: vi.fn(async () => reservation),
    settle: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const runAdmission: RunAdmissionPort = {
    acquire: async () => {
      throw new Error("Not used by accounting tests");
    },
    renew: vi.fn(async (request) => ({
      leaseId: request.leaseId,
      fencingToken: request.fencingToken,
      expiresAt: request.expiresAt,
    })),
    waitForInput: async () => null,
    resume: async (request) => ({
      leaseId: request.leaseId,
      fencingToken: request.fencingToken,
      expiresAt: request.expiresAt,
    }),
    release: async () => false,
  };
  const prices: UsagePriceRepository = {
    findActive: vi.fn(async () => priceRecord),
    insert: vi.fn(async () => {}),
  };
  const accounting = createAdmittedUsageAccounting({
    admission,
    runAdmission,
    prices,
    limits: {
      userSpendLimitUsd: 10,
      globalSpendLimitUsd: 100,
      spendPeriodSeconds: 86_400,
    },
    now,
    runLeaseTtlSeconds,
  });
  return { accounting, admission, prices, runAdmission };
}

function admittedAttempt(): Omit<
  UsageAttempt,
  "outcome" | "units" | "errorCode"
> {
  return {
    attemptId: "attempt-1",
    context: {
      userId: "user-1",
      caseId: "case-1",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
    },
    provider: "muse",
    model: "spark",
    settings,
    maxInputTokens: 1_000,
    maxOutputTokens: 200,
    searchRequested: false,
  };
}

function completedAttempt(
  units: UsageAttempt["units"] = {
    input: 1_000,
    output: 500,
    total: 1_500,
    reasoning: 200,
    cacheRead: 100,
    cacheWrite: 0,
    search: 0,
  },
): UsageAttempt {
  return {
    ...admittedAttempt(),
    outcome: "success",
    units,
  };
}

describe("admitted usage accounting", () => {
  it("reserves a bounded worst-case allowance before the provider call", async () => {
    const { accounting, admission } = setup();
    await accounting.admit(admittedAttempt());

    expect(admission.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "attempt-1",
        inputAllowanceTokens: 1_000,
        outputAllowanceTokens: 200,
        userSpendLimitUsd: 10,
        globalSpendLimitUsd: 100,
      }),
    );
  });

  it("uses a fresh timestamp after loading the active price", async () => {
    const now = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-06-01T12:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-06-01T12:01:00.000Z"))
      .mockReturnValue(new Date("2026-06-01T12:01:00.000Z"));
    const { accounting, admission, prices } = setup(price, now);
    await accounting.admit(admittedAttempt());

    expect(prices.findActive).toHaveBeenCalledWith(
      "muse",
      "spark",
      settingsKey,
      "2026-06-01T12:00:00.000Z",
    );
    expect(admission.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        at: "2026-06-01T12:01:00.000Z",
        expiresAt: "2026-06-01T12:16:00.000Z",
      }),
    );
  });

  it("aborts active work when a lease heartbeat is rejected", async () => {
    vi.useFakeTimers();
    try {
      const { accounting, runAdmission } = setup(price, undefined, 3);
      vi.mocked(runAdmission.renew)
        .mockResolvedValueOnce({
          leaseId: "lease-1",
          fencingToken: 1,
          expiresAt: "2026-06-01T12:00:03.000Z",
        })
        .mockResolvedValueOnce(null);

      const signal = await accounting.admit(admittedAttempt());
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signal?.aborted).toBe(true);

      await accounting.cancel("attempt-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts at the last confirmed expiry and bounds cancellation while renewal hangs", async () => {
    vi.useFakeTimers();
    try {
      const { accounting, runAdmission } = setup(price, undefined, 3);
      vi.mocked(runAdmission.renew)
        .mockResolvedValueOnce({
          leaseId: "lease-1",
          fencingToken: 1,
          expiresAt: "2026-06-01T12:00:03.000Z",
        })
        .mockImplementationOnce(() => new Promise(() => {}));

      const signal = await accounting.admit(admittedAttempt());
      await vi.advanceTimersByTimeAsync(2_000);
      expect(signal?.aborted).toBe(true);

      let cancelled = false;
      const cancel = accounting.cancel("attempt-1").then(() => {
        cancelled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await cancel;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the reservation when the pre-dispatch renewal hangs", async () => {
    vi.useFakeTimers();
    try {
      const { accounting, admission, runAdmission } = setup();
      vi.mocked(runAdmission.renew).mockImplementationOnce(
        () => new Promise(() => {}),
      );

      const admitted = accounting.admit(admittedAttempt());
      const rejection = expect(admitted).rejects.toThrow(
        "Run lease renewal timed out before provider dispatch",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(admission.release).toHaveBeenCalledWith(
        "reservation:attempt-1",
        "cancelled",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects dispatch synchronously when the renewed lease is already expiring", async () => {
    const { accounting, admission, runAdmission } = setup();
    vi.mocked(runAdmission.renew).mockResolvedValueOnce({
      leaseId: "lease-1",
      fencingToken: 1,
      expiresAt: "2026-06-01T12:00:00.500Z",
    });

    await expect(accounting.admit(admittedAttempt())).rejects.toThrow(
      "The run lease expired before provider dispatch",
    );
    expect(admission.release).toHaveBeenCalledWith(
      "reservation:attempt-1",
      "cancelled",
    );
    await expect(accounting.cancel("attempt-1")).resolves.toBeUndefined();
  });

  it("settles known provider usage using the versioned model price", async () => {
    const { accounting, admission } = setup();
    await accounting.admit(admittedAttempt());
    const result = await accounting.record(completedAttempt());

    expect(result).toMatchObject({
      status: "estimated",
      costUsd: 0.00195,
      pricingIdentity: "muse:spark",
    });
    expect(admission.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        units: expect.objectContaining({ cacheWrite: 0 }),
      }),
    );
  });

  it("retains the reservation when provider usage is unknown", async () => {
    const { accounting, admission } = setup();
    await accounting.admit(admittedAttempt());
    const result = await accounting.record(
      completedAttempt({
        input: null,
        output: null,
        total: null,
        reasoning: null,
        cacheRead: null,
        cacheWrite: null,
        search: null,
      }),
    );

    expect(result).toMatchObject({ status: "unknown", costUsd: null });
    expect(admission.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        units: {
          input: null,
          output: null,
          total: null,
          reasoning: null,
          cacheRead: null,
          cacheWrite: null,
          search: null,
        },
      }),
    );
    expect(admission.release).not.toHaveBeenCalled();
  });

  it("rejects paid work when no active price is configured", async () => {
    const { accounting, admission } = setup(null);
    await expect(accounting.admit(admittedAttempt())).rejects.toMatchObject({
      code: "usage-admission-rejected",
      message:
        'No active price is configured for muse:spark with settings {"maxOutputTokens":200}. Ask an administrator to import a matching price record.',
    });
    expect(admission.reserve).not.toHaveBeenCalled();
  });

  it("rejects requested capabilities without a known price", async () => {
    const { accounting } = setup({ ...price, searchUsdPerRequest: null });
    await expect(
      accounting.admit({
        ...admittedAttempt(),
        searchRequested: true,
      }),
    ).rejects.toBeInstanceOf(AdmissionRejectedError);
  });

  it("requires a case and run scope for paid work", async () => {
    const { accounting, admission } = setup();
    await expect(
      accounting.admit({
        ...admittedAttempt(),
        context: { userId: "user-1" },
      }),
    ).rejects.toBeInstanceOf(AdmissionRejectedError);
    expect(admission.reserve).not.toHaveBeenCalled();
  });

  it("treats unknown cache or search units as unknown exposure", () => {
    expect(
      estimateUsageCost(
        {
          input: 100,
          output: 50,
          total: 150,
          cacheRead: null,
          cacheWrite: null,
          search: null,
        },
        price,
        true,
      ),
    ).toMatchObject({ status: "unknown", costUsd: null });
  });
});
