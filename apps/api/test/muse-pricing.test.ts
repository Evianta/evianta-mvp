import { modelForTier, pricingSettingsKey } from "@evianta/ai";
import {
  estimateUsageAllowance,
  estimateUsageCost,
  type UsagePrice,
} from "@evianta/core";
import { createInMemoryStore, StoreError } from "@evianta/store";
import { describe, expect, it, vi } from "vitest";
import { musePricing, seedMusePrices } from "../src/muse-pricing.js";

const models = {
  provider: "muse",
  sparkModel: "spark",
  wonderModel: "wonder",
  maxOutputTokens: 2048,
} as const;
const at = "2026-11-03T00:00:00.000Z";
const settingsKey = pricingSettingsKey({ maxOutputTokens: 2048 });

describe("published Muse pricing", () => {
  it.each([
    ["spark", "wonder"],
    ["muse-spark-1.1", "muse-wonder-1.0"],
    ["muse-spark-1.2", "muse-wonder-1.0"],
    ["muse-spark-1.3", "muse-wonder-1.0"],
  ])("provisions real Standard rates for %s and %s", async (spark, wonder) => {
    const prices = createInMemoryStore().repositories.usagePrices;
    await seedMusePrices(prices, {
      ...models,
      sparkModel: spark,
      wonderModel: wonder,
    });
    const sparkPrice = await prices.findActive("muse", spark, settingsKey, at);
    const wonderPrice = await prices.findActive(
      "muse",
      wonder,
      settingsKey,
      at,
    );
    expect(sparkPrice).toMatchObject({
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 4.25,
      cacheReadUsdPerMillion: 0.15,
      cacheWriteUsdPerMillion: 1.25,
      searchUsdPerRequest: null,
      source: expect.stringContaining(musePricing.source),
    });
    expect(wonderPrice).toMatchObject({
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
      cacheReadUsdPerMillion: 0.2,
      cacheWriteUsdPerMillion: 4,
    });
    if (!sparkPrice || !wonderPrice) throw new Error("Missing prices");
    const units = {
      input: 1_000_000,
      output: 1_000_000,
      total: 2_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    };
    expect(
      estimateUsageAllowance(1_000_000, 1_000_000, false, sparkPrice),
    ).toBe(5.5);
    expect(estimateUsageCost(units, wonderPrice, false).costUsd).toBe(24);
    expect(
      estimateUsageCost({ ...units, cacheRead: 1_000_000 }, sparkPrice, false)
        .costUsd,
    ).toBe(4.4);
    expect(estimateUsageAllowance(1, 1, true, sparkPrice)).toBeNull();
  });

  it("is idempotent and preserves an existing active operator price", async () => {
    const prices = createInMemoryStore().repositories.usagePrices;
    await seedMusePrices(prices, models);
    const base = await prices.findActive("muse", "spark", settingsKey, at);
    if (!base) throw new Error("Missing Spark price");
    const override: UsagePrice = {
      ...base,
      id: "operator-spark-v2",
      version: 2,
      source: "operator-confirmed account price",
    };
    await prices.insert(override);
    const insert = vi.spyOn(prices, "insert");
    await seedMusePrices(prices, models);
    expect(insert).not.toHaveBeenCalled();
    expect(await prices.findActive("muse", "spark", settingsKey, at)).toEqual(
      override,
    );
  });

  it("handles concurrent startup and changed output limits", async () => {
    const prices = createInMemoryStore().repositories.usagePrices;
    await Promise.all([
      seedMusePrices(prices, models),
      seedMusePrices(prices, models),
    ]);
    await seedMusePrices(prices, { ...models, maxOutputTokens: 16384 });
    const model = modelForTier("high", {
      ...models,
      maxOutputTokens: 16384,
    });
    expect(
      await prices.findActive(
        "muse",
        "wonder",
        pricingSettingsKey(model.pricingSettings),
        at,
      ),
    ).toMatchObject({
      settings: { maxOutputTokens: 16384 },
      outputUsdPerMillion: 20,
    });
    expect(
      await prices.findActive("muse", "wonder", settingsKey, at),
    ).not.toBeNull();
  });

  it.each(["unknown-model", "muse-spark-1.3-contributor"])(
    "rejects unconfigured model %s without partially provisioning",
    async (wonderModel) => {
      const prices = createInMemoryStore().repositories.usagePrices;
      const insert = vi.spyOn(prices, "insert");
      await expect(
        seedMusePrices(prices, { ...models, wonderModel }),
      ).rejects.toThrow("No published Standard-mode price");
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("does not seed mock prices or suppress persistence failures", async () => {
    const prices = createInMemoryStore().repositories.usagePrices;
    const insert = vi.spyOn(prices, "insert");
    await seedMusePrices(prices, { ...models, provider: "mock" });
    expect(insert).not.toHaveBeenCalled();
    insert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(seedMusePrices(prices, models)).rejects.toThrow(
      "database unavailable",
    );
    insert.mockRejectedValueOnce(
      new StoreError("Version exists but is not active", "duplicate-price"),
    );
    await expect(seedMusePrices(prices, models)).rejects.toMatchObject({
      code: "duplicate-price",
    });
  });
});
