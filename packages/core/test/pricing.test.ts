import { describe, expect, it } from "vitest";
import {
  estimateUsageAllowance,
  estimateUsageCost,
  type UsagePrice,
} from "../src/index.js";

const price: UsagePrice = {
  id: "price-low-rate",
  provider: "muse",
  model: "spark",
  settingsKey: "settings",
  settings: {},
  currency: "USD",
  inputUsdPerMillion: 0.000000004,
  outputUsdPerMillion: 0,
  cacheReadUsdPerMillion: 0.000000004,
  cacheWriteUsdPerMillion: 0.000000004,
  searchUsdPerRequest: null,
  version: 1,
  source: "test",
  effectiveAt: "2026-01-01T00:00:00.000Z",
};

describe("usage price precision", () => {
  it("preserves low positive rates until after token multiplication", () => {
    expect(estimateUsageAllowance(1_000_000_000, 1, false, price)).toBe(
      0.000004,
    );
    expect(
      estimateUsageCost(
        {
          input: 1_000_000_000,
          output: 1,
          total: 1_000_000_001,
          cacheRead: null,
          cacheWrite: null,
          search: 0,
        },
        price,
        false,
      ),
    ).toEqual({ status: "estimated", costUsd: 0.000004 });
  });

  it("does not settle token totals that exceed priced input and output units", () => {
    expect(
      estimateUsageCost(
        {
          input: 0,
          output: 0,
          total: 1,
          reasoning: null,
          cacheRead: 0,
          cacheWrite: 0,
          search: 0,
        },
        price,
        false,
      ),
    ).toEqual({ status: "unknown", costUsd: null });
  });
});
