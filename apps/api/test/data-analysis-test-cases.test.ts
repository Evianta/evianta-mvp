import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSalesTables } from "@evianta/agents";
import {
  parseDelimited,
  parseWorkbook,
  resolveIngestionSettings,
} from "@evianta/ingestion";
import { describe, expect, it } from "vitest";

interface PackCase {
  id: string;
  folder: string;
  input_file: string;
  expected: {
    error?: string;
    rowCount?: number;
    valueColumn?: string;
    total?: number;
    periodColumn?: string;
    segmentColumn?: string;
    topSegment?: { label: string; value: number };
    periodCount?: number;
    sheet?: string;
    dataQualityCodes?: string[];
  };
}

const packRoot = fileURLToPath(
  new URL("../../../test-cases/business-data-analysis/", import.meta.url),
);
const pack = JSON.parse(
  readFileSync(join(packRoot, "case-index.json"), "utf8"),
) as { cases: PackCase[] };
const limits = resolveIngestionSettings().limits;

function analyze(item: PackCase) {
  const path = join(packRoot, item.folder, item.input_file);
  const parsed = item.input_file.endsWith(".xlsx")
    ? parseWorkbook(readFileSync(path), limits, true)
    : parseDelimited(readFileSync(path, "utf8"), ",", limits);
  return analyzeSalesTables(
    parsed.tables.map((table) => ({
      documentId: item.id,
      name: item.input_file,
      table,
    })),
  );
}

describe("business data analysis test pack", () => {
  it.each(pack.cases)("$folder matches its documented expectations", (item) => {
    const { expected } = item;
    if (expected.error) {
      expect(() => analyze(item)).toThrow(expected.error);
      return;
    }
    const result = analyze(item);
    expect(result.metrics).toMatchObject({
      rowCount: expected.rowCount,
      valueColumn: expected.valueColumn,
      total: expected.total,
      periodColumn: expected.periodColumn,
      segmentColumn: expected.segmentColumn,
      topSegment: expected.topSegment,
    });
    if (expected.periodCount !== undefined)
      expect(result.metrics.byPeriod).toHaveLength(expected.periodCount);
    if (expected.sheet)
      expect(result.sourceEvidence.location?.sheet).toBe(expected.sheet);
    expect(
      [...new Set(result.dataQuality.map((issue) => issue.code))].sort(),
    ).toEqual(expected.dataQualityCodes);
  });
});
