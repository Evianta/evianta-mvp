import { readFileSync } from "node:fs";
import { createAi, MockProvider } from "@evianta/ai";
import { syntheticWorkflowFixtures, type ExtractedTable } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeSalesTables,
  createBusinessDataAnalystAgent,
} from "../src/data-analysis.js";
import type { AgentContext } from "../src/agent.js";
import type { SpecialistInput } from "../src/contracts.js";

const table: ExtractedTable = {
  id: "sales-table",
  pageIndex: null,
  sheet: "Sales",
  cellRange: "A1:C7",
  headers: ["month", "product", "revenue"],
  columnTypes: ["string", "string", "number"],
  rows: [
    ["Jan", "A", "100"],
    ["Jan", "B", "150"],
    ["Feb", "A", "120"],
    ["Feb", "B", "180"],
    ["Mar", "A", "200"],
    ["Mar", "B", "250"],
  ],
};

const sourceTables = [
  {
    documentId: "sales-document",
    name: "quarterly-sales.csv",
    table,
  },
];
const narrativeFixture = readFileSync(
  new URL("./fixtures/data-analysis-narrative.json", import.meta.url),
  "utf8",
);

describe("business data analyst", () => {
  it("computes exact sales metrics and dashboard values deterministically", () => {
    const result = analyzeSalesTables(sourceTables);

    expect(result.metrics).toEqual({
      rowCount: 6,
      valueColumn: "revenue",
      total: 1000,
      average: 1000 / 6,
      periodColumn: "month",
      byPeriod: [
        { label: "Jan", value: 250, growthPercent: null },
        { label: "Feb", value: 300, growthPercent: 20 },
        { label: "Mar", value: 450, growthPercent: 50 },
      ],
      segmentColumn: "product",
      bySegment: [
        { label: "B", value: 580 },
        { label: "A", value: 420 },
      ],
      topSegment: { label: "B", value: 580 },
    });
    expect(result.dashboard.charts.map((chart) => chart.type)).toEqual([
      "bar",
      "line",
      "pie",
    ]);
    expect(result.dashboard.charts[0]?.data).toEqual([
      { period: "Jan", revenue: 250 },
      { period: "Feb", revenue: 300 },
      { period: "Mar", revenue: 450 },
    ]);
    expect(result.sourceEvidence.location).toMatchObject({
      sheet: "Sales",
      cellRange: "A2:C7",
      rowRange: { start: 2, end: 7 },
    });
    expect(result.dataQuality).toEqual([]);
  });

  it("flags missing, duplicate, inconsistent, and out-of-range values", () => {
    const messy = analyzeSalesTables([
      {
        documentId: "messy-doc",
        name: "messy.csv",
        table: {
          ...table,
          rows: [
            ["2026-01-01", "A", "100"],
            ["01/02/2026", "B", "150"],
            ["2026-02-01", "A", "120"],
            ["2026-02-01", "A", "120"],
            ["2026-03-01", "B", "-20"],
            ["2026-03-01", "C", "unknown"],
            ["2026-03-02", "D", null],
          ],
        },
      },
    ]);

    expect(messy.metrics.total).toBe(470);
    expect(messy.dataQuality.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "missing-values",
        "duplicate-rows",
        "type-mismatch",
        "out-of-range",
        "inconsistent-date-formats",
      ]),
    );
    expect(messy.qualityEvidence.length).toBeGreaterThan(0);
    expect(messy.qualityEvidence.every((item) => item.location?.rowRange)).toBe(
      true,
    );
  });

  it("returns report, chart spec, and source evidence after one mock narrative call", async () => {
    const provider = new MockProvider({
      responses: [narrativeFixture],
    });
    const generate = vi.spyOn(provider, "generateStructured");
    const ai = createAi({
      provider,
      accounting: {
        mode: "test",
        admit: async () => undefined,
        record: async () => undefined,
        cancel: async () => undefined,
      },
      models: {
        provider: "mock",
        sparkModel: "mock-spark",
        wonderModel: "mock-wonder",
      },
    });
    const context: AgentContext = {
      ownerId: "sales-owner",
      case: syntheticWorkflowFixtures.dataAnalysis.case,
      runId: "sales-run",
      taskId: "sales-task",
      documents: {
        listAsync: async () => [],
        tablesAsync: async () => sourceTables,
        sliceAsync: async () => null,
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      signal: new AbortController().signal,
      usage: {
        userId: "sales-owner",
        caseId: "sales-case",
        runId: "sales-run",
        leaseId: "sales-lease",
        fencingToken: 1,
      },
      ai,
    };
    const input: SpecialistInput = {
      case: {
        title: "Quarterly sales",
        description: "",
        useCase: "data-analysis",
      },
      task: {
        id: "sales-task",
        key: "sales-analysis",
        role: "business-data-analyst",
        instructions: "Analyze the source table",
      },
      priorFindings: [],
      documents: [],
      humanInput: null,
    };

    const result = await createBusinessDataAnalystAgent().run(input, context);

    expect(generate).toHaveBeenCalledOnce();
    expect(result.output.report?.metrics.total).toBe(1000);
    expect(result.output.dashboard?.charts).toHaveLength(3);
    expect(result.output.findings[0]?.evidence[0]?.location).toMatchObject({
      rowRange: { start: 2, end: 7 },
    });
    expect(
      result.output.findings.some(
        (finding) => finding.title === "Revenue increased by period",
      ),
    ).toBe(true);
  });
});
