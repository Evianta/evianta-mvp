import { pricingSettingsKey } from "@evianta/ai";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";
import { parseUsagePrice } from "../src/usage-price.js";

const input = {
  id: "operator-price-1",
  provider: "muse",
  model: "spark",
  settings: { maxOutputTokens: 2048 },
  currency: "USD",
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  cacheReadUsdPerMillion: 0.5,
  cacheWriteUsdPerMillion: 1,
  searchUsdPerRequest: null,
  version: 1,
  source: "synthetic test rates",
  effectiveAt: "2026-01-01T00:00:00.000Z",
};

describe("operator price import", () => {
  it("derives the exact settings hash and stores an immutable price version", async () => {
    const price = parseUsagePrice(input);
    expect(price.settingsKey).toBe(pricingSettingsKey(input.settings));
    const { usagePrices } = createInMemoryStore().repositories;
    await usagePrices.insert(price);
    expect(
      await usagePrices.findActive(
        "muse",
        "spark",
        pricingSettingsKey({ maxOutputTokens: 2048 }),
        "2026-11-02T00:00:00.000Z",
      ),
    ).toEqual(price);
    expect(
      await usagePrices.findActive(
        "muse",
        "spark",
        pricingSettingsKey({ maxOutputTokens: 1024 }),
        "2026-11-02T00:00:00.000Z",
      ),
    ).toBeNull();
    await expect(
      usagePrices.insert({ ...price, inputUsdPerMillion: 0 }),
    ).rejects.toMatchObject({ code: "duplicate-price" });
  });

  it.each([
    { ...input, inputUsdPerMillion: -1 },
    { ...input, outputUsdPerMillion: "2" },
    { ...input, cacheReadUsdPerMillion: undefined },
    { ...input, version: 0 },
    { ...input, effectiveAt: "yesterday" },
    { ...input, settings: { nested: {} } },
    { ...input, settingsKey: "hand-written-hash" },
    { ...input, inputUsdPerMilion: 1 },
  ])("rejects invalid or ambiguous price input", (invalid) => {
    expect(() => parseUsagePrice(invalid)).toThrow();
  });
});
