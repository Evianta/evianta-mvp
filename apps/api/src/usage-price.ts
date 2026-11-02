import { pricingSettingsKey } from "@evianta/ai";
import { UsagePriceSchema, type UsagePrice } from "@evianta/core";
import { z } from "zod";

const PriceInputSchema = UsagePriceSchema.omit({ settingsKey: true })
  .extend({
    settings: z.record(
      z.string(),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    ),
  })
  .strict();

export function parseUsagePrice(input: unknown): UsagePrice {
  const price = PriceInputSchema.parse(input);
  return {
    ...price,
    settingsKey: pricingSettingsKey(price.settings),
  };
}
