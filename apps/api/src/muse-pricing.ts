import { modelForTier, type ModelSettings } from "@evianta/ai";
import type { UsagePrice, UsagePriceRepository } from "@evianta/core";
import { StoreError } from "@evianta/store";
import { parseUsagePrice } from "./usage-price.js";

export const musePricing = {
  version: 1,
  verifiedAt: "2026-11-02T00:00:00.000Z",
  source: "https://dev.meta.ai/docs/pricing-rate-limits",
  spark: {
    models: ["spark", "muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.3"],
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 4.25,
    cacheReadUsdPerMillion: 0.15,
  },
  wonder: {
    models: ["wonder", "muse-wonder-1.0"],
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    cacheReadUsdPerMillion: 0.2,
  },
} as const;

export async function seedMusePrices(
  prices: UsagePriceRepository,
  models: ModelSettings,
): Promise<void> {
  if (models.provider !== "muse") return;
  const at = new Date().toISOString();
  const records = (["cheap", "high"] as const).map((tier): UsagePrice => {
    const model = modelForTier(tier, models);
    const rates = [musePricing.spark, musePricing.wonder].find((family) =>
      family.models.some((id) => id === model.model),
    );
    if (!rates) {
      throw new Error(
        `No published Standard-mode price is configured in code for muse:${model.model}. Add verified pricing before starting the runtime.`,
      );
    }
    const price = parseUsagePrice({
      id: `muse:${model.model}:standard:v${musePricing.version}`,
      provider: "muse",
      model: model.model,
      settings: model.pricingSettings,
      currency: "USD",
      inputUsdPerMillion: rates.inputUsdPerMillion,
      outputUsdPerMillion: rates.outputUsdPerMillion,
      cacheReadUsdPerMillion: rates.cacheReadUsdPerMillion,
      // Meta lists no separate cache-write charge; writes use the input rate.
      cacheWriteUsdPerMillion: rates.inputUsdPerMillion,
      searchUsdPerRequest: null,
      version: musePricing.version,
      source: `${musePricing.source} (Standard mode; verified 2026-11-02)`,
      effectiveAt: musePricing.verifiedAt,
    });
    return { ...price, id: `${price.id}:${price.settingsKey}` };
  });
  for (const price of records) {
    if (
      await prices.findActive(
        price.provider,
        price.model,
        price.settingsKey,
        at,
      )
    ) {
      continue;
    }
    try {
      await prices.insert(price);
    } catch (error) {
      if (
        !(error instanceof StoreError) ||
        error.code !== "duplicate-price" ||
        !(await prices.findActive(
          price.provider,
          price.model,
          price.settingsKey,
          at,
        ))
      ) {
        throw error;
      }
    }
  }
}
