import { readFileSync } from "node:fs";
import { createAi, inputTokenAllowance, MockProvider } from "@evianta/ai";
import { syntheticWorkflowFixtures, type ExtractedTable } from "@evianta/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  analyzeSalesTables,
  createBusinessDataAnalystAgent,
} from "../src/data-analysis.js";
import type { AgentContext } from "../src/agent.js";
import {
  SpecialistModelOutputSchema,
  type SpecialistInput,
} from "../src/contracts.js";

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

  it("uses workbook column origins when locating source evidence", () => {
    const result = analyzeSalesTables([
      {
        documentId: "workbook-doc",
        name: "workbook.xlsx",
        table: { ...table, cellRange: "D5:F11" },
      },
    ]);

    expect(result.sourceEvidence.location).toMatchObject({
      cellRange: "D6:F11",
      rowRange: { start: 6, end: 11 },
    });
  });

  it("uses extracted physical row numbers for quality evidence", () => {
    const result = analyzeSalesTables([
      {
        documentId: "blank-lines-doc",
        name: "blank-lines.csv",
        table: {
          ...table,
          headers: ["product", "revenue"],
          rows: [
            ["A", "100"],
            ["B", "unknown"],
            ["C", "50"],
          ],
          sourceRowNumbers: [2, 4, 5],
          cellRange: "A1:B5",
        },
      },
    ]);

    const issue = result.dataQuality.find(
      ({ code }) => code === "type-mismatch",
    );
    expect(issue?.rows).toEqual([{ start: 4, end: 4 }]);
    expect(
      result.qualityEvidence.find((evidence) =>
        evidence.sourceRef.includes(":revenue:"),
      )?.location,
    ).toMatchObject({
      cellRange: "B4:B4",
      rowRange: { start: 4, end: 4 },
    });
  });

  it("sorts supported year, quarter, and week labels before computing growth", () => {
    for (const [header, labels, expectedLabels] of [
      ["year", ["2026", "2025"], ["2025", "2026"]],
      ["quarter", ["2026-Q2", "Q1 2026"], ["Q1 2026", "2026-Q2"]],
      ["week", ["2026-W02", "W01 2026"], ["W01 2026", "2026-W02"]],
    ] as const) {
      const result = analyzeSalesTables([
        {
          documentId: "period-doc",
          name: "periods.csv",
          table: {
            ...table,
            headers: [header, "revenue"],
            rows: [
              [labels[0], "100"],
              [labels[1], "50"],
            ],
          },
        },
      ]);

      expect(result.metrics.byPeriod.map(({ label }) => label)).toEqual(
        expectedLabels,
      );
      expect(result.metrics.byPeriod[1]?.growthPercent).toBe(100);
    }

    const unknownOrder = analyzeSalesTables([
      {
        documentId: "unknown-period-doc",
        name: "unknown-periods.csv",
        table: {
          ...table,
          headers: ["period", "revenue"],
          rows: [
            ["FY26", "100"],
            ["FY25", "50"],
          ],
        },
      },
    ]);
    expect(
      unknownOrder.metrics.byPeriod.map(({ growthPercent }) => growthPercent),
    ).toEqual([null, null]);
  });

  it("selects revenue over IDs and unit prices and reports tied measures", () => {
    const result = analyzeSalesTables([
      {
        documentId: "measure-doc",
        name: "measures.csv",
        table: {
          ...table,
          headers: [
            "month",
            "sales_rep_id",
            "unit_price",
            "quantity",
            "revenue",
          ],
          rows: [
            ["Jan", "10001", "5", "2", "10"],
            ["Feb", "10002", "7", "3", "21"],
          ],
        },
      },
    ]);
    expect(result.metrics.valueColumn).toBe("revenue");
    expect(result.metrics.total).toBe(31);

    const ambiguous = analyzeSalesTables([
      {
        documentId: "ambiguous-doc",
        name: "ambiguous.csv",
        table: {
          ...table,
          headers: ["month", "revenue", "net revenue"],
          rows: [
            ["Jan", "10", "9"],
            ["Feb", "20", "18"],
          ],
        },
      },
    ]);
    expect(ambiguous.assumptions[0]).toContain("net revenue");
    expect(ambiguous.openQuestions[0]?.severity).toBe("medium");
  });

  it("rejects oversized persisted analysis results before any narrative call", () => {
    const rows = Array.from({ length: 80_000 }, (_, index) => [
      `segment-${String(index).padStart(6, "0")}-${"x".repeat(48)}`,
      "1",
    ]);
    expect(() =>
      analyzeSalesTables([
        {
          documentId: "large-doc",
          name: "large.csv",
          table: {
            ...table,
            headers: ["product", "revenue"],
            rows,
          },
        },
      ]),
    ).toThrow(/8 MiB persistence safety limit/);
  });

  it("returns report, chart spec, and source evidence after one mock narrative call", async () => {
    const provider = new MockProvider({
      responses: [narrativeFixture, narrativeFixture],
    });
    const generate = vi.spyOn(provider, "generateStructured");
    let tablesForAnalysis = [
      ...sourceTables,
      {
        documentId: "unreferenced-document",
        name: "unreferenced.csv",
        table: {
          ...table,
          rows: [...table.rows, ...table.rows, ...table.rows],
        },
      },
    ];
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
        tablesAsync: vi.fn(async () => tablesForAnalysis),
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
        description: "Review the quarterly revenue movement.",
        useCase: "data-analysis",
      },
      task: {
        id: "sales-task",
        key: "sales-analysis",
        role: "business-data-analyst",
        instructions: "Compare periods and explain the relevant caveats.",
      },
      priorFindings: [],
      documents: [
        {
          documentId: "sales-document",
          name: "quarterly-sales.csv",
          pages: [],
          tables: [],
          truncated: true,
        },
      ],
      humanInput: null,
    };

    const result = await createBusinessDataAnalystAgent().run(input, context);

    expect(generate).toHaveBeenCalledOnce();
    expect(context.documents.tablesAsync).toHaveBeenCalledWith([
      "sales-document",
    ]);
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
    expect(result.output.report?.assumptions).toContain(
      "The periods represent calendar months.",
    );
    expect(result.output.report?.openQuestions).toContainEqual({
      text: "Would another period grouping be more useful?",
      severity: "low",
    });
    expect(result.output.report?.metrics.rowCount).toBe(6);
    expect(result.output.findings[0]?.evidence[0]?.documentId).toBe(
      "sales-document",
    );
    const narrativeInput = generate.mock.calls[0]?.[0].input as {
      caseContext: string;
      analysisInstructions: string;
    };
    expect(narrativeInput.caseContext).toContain(
      "Review the quarterly revenue movement.",
    );
    expect(narrativeInput.analysisInstructions).toContain(
      "Compare periods and explain the relevant caveats.",
    );

    tablesForAnalysis = [
      {
        documentId: "sales-document",
        name: "messy-sales.csv",
        table: {
          ...table,
          rows: [
            ["2026-01", "A", "100"],
            ["2026-02", "B", "unknown"],
            ["2026-03", "C", null],
            ["2026-04", "D", "-20"],
          ],
        },
      },
    ];
    const messyResult = await createBusinessDataAnalystAgent().run(
      input,
      context,
    );
    const evidenceRows = (title: string) =>
      messyResult.output.findings
        .find((finding) => finding.title === title)
        ?.evidence.map((evidence) => evidence.location?.rowRange);
    expect(evidenceRows("Data quality: type mismatch")).toEqual([
      { start: 3, end: 3 },
    ]);
    expect(evidenceRows("Data quality: missing values")).toEqual([
      { start: 4, end: 4 },
    ]);
    expect(evidenceRows("Data quality: out of range")).toEqual([
      { start: 5, end: 5 },
    ]);
  });

  it("keeps high-cardinality narrative inputs under the configured token budget", async () => {
    const highCardinalityRows = Array.from({ length: 240 }, (_, index) => {
      const year = 2020 + Math.floor(index / 12);
      const month = String((index % 12) + 1).padStart(2, "0");
      return [`${year}-${month}`, `segment-${index}`, String(index + 1)];
    });
    const highCardinalityTable: ExtractedTable = {
      ...table,
      headers: ["month", "product", "revenue"],
      rows: highCardinalityRows,
      cellRange: "A1:C241",
    };
    const provider = new MockProvider({ responses: [narrativeFixture] });
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
        tablesAsync: async () => [
          {
            documentId: "sales-document",
            name: "high-cardinality.csv",
            table: highCardinalityTable,
          },
        ],
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
        title: "High cardinality",
        description: "",
        useCase: "data-analysis",
      },
      task: {
        id: "sales-task",
        key: "sales-analysis",
        role: "business-data-analyst",
        instructions: "Summarize the data.",
      },
      priorFindings: [],
      documents: [
        {
          documentId: "sales-document",
          name: "high-cardinality.csv",
          pages: [],
          tables: [],
          truncated: true,
        },
      ],
      humanInput: null,
    };

    const result = await createBusinessDataAnalystAgent().run(input, context);

    expect(result.output.report?.metrics.byPeriod).toHaveLength(240);
    const request = generate.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(
      inputTokenAllowance({
        system: request!.system,
        input: request!.input,
        schema: request!.schema,
      }),
    ).toBeLessThanOrEqual(ai.inputTokenLimit("mid") - 1024);
    const narrative = request!.input as {
      metrics: { byPeriod: unknown[]; bySegment: unknown[] };
      omittedPeriodCount: number;
      omittedSegmentCount: number;
    };
    expect(narrative.metrics.byPeriod.length).toBeLessThan(240);
    expect(narrative.metrics.bySegment.length).toBeLessThan(240);
    expect(narrative.omittedPeriodCount).toBeGreaterThan(0);
    expect(narrative.omittedSegmentCount).toBeGreaterThan(0);
  });

  it("keeps the model-facing specialist schema strict-compatible", () => {
    const schema = z.toJSONSchema(SpecialistModelOutputSchema) as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties).not.toHaveProperty("report");
    expect(schema.properties).not.toHaveProperty("dashboard");
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("location");
    expect(serialized).not.toContain('additionalProperties":{}');

    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const object = value as Record<string, unknown>;
      if (object.type === "object" && typeof object.properties === "object") {
        const properties = object.properties as Record<string, unknown>;
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(properties));
        Object.values(properties).forEach(visit);
      }
      for (const key of ["items", "anyOf", "allOf", "oneOf"]) {
        if (key in object) visit(object[key]);
      }
    };
    visit(schema);
  });
});
