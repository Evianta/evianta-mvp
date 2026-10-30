import {
  DataAnalysisDashboardSchema,
  DataAnalysisMetricsSchema,
  DataAnalysisReportSchema,
  DataQualityIssueSchema,
  type DataAnalysisDashboard,
  type DataAnalysisMetrics,
  type DataAnalysisReport,
  type DataQualityIssue,
  type ExtractedTable,
} from "@evianta/core";
import { z } from "zod";
import { toAgentResult, type AgentContext, type AgentResult } from "./agent.js";
import {
  SpecialistInputSchema,
  SpecialistOutputSchema,
  type EvidenceDraft,
  type SpecialistInput,
  type SpecialistOutput,
} from "./contracts.js";
import type { SpecialistAgent } from "./roles.js";

export const BUSINESS_DATA_ANALYST_ROLE = "business-data-analyst";

export const businessDataAnalystProfile = {
  id: "agent-business-data-analyst",
  role: BUSINESS_DATA_ANALYST_ROLE,
  displayName: "Business Data Analyst",
  specialty: "Sales and tabular analysis",
  summary:
    "Computes reproducible sales metrics and explains trends with row-linked evidence.",
  capabilities: [
    "Compute exact totals, averages, period changes, and segment rankings",
    "Identify common data-quality issues",
    "Produce evidence-linked reports and safe chart specifications",
  ],
  tools: [],
  procedures: [
    "Compute numeric results deterministically before narrative analysis",
    "Use only supplied aggregates for interpretation",
    "Link material findings to source rows and columns",
  ],
  outputFormats: ["report", "dashboard chart specification"],
  limitations: [
    "Does not infer missing business context or modify source data",
  ],
  modelTier: "mid" as const,
  enabled: true,
};

interface SourceTable {
  documentId: string;
  name: string;
  table: ExtractedTable;
}

interface DataAnalysisResult {
  table: SourceTable;
  metrics: DataAnalysisMetrics;
  summary: string;
  dataQuality: DataQualityIssue[];
  dashboard: DataAnalysisDashboard;
  sourceEvidence: EvidenceDraft;
  qualityEvidence: EvidenceDraft[];
  assumptions: string[];
  openQuestions: Array<{
    text: string;
    severity: "high" | "medium" | "low";
  }>;
  sampleRows: Array<Record<string, string | null>>;
}

const NarrativeInputSchema = z.object({
  metrics: DataAnalysisMetricsSchema,
  dataQuality: z.array(DataQualityIssueSchema),
  sampleRows: z.array(z.record(z.string(), z.string().nullable())),
});

const NarrativeOutputSchema = z.object({
  interpretation: z.string(),
  insights: z.array(
    z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      severity: z.enum(["high", "medium", "low", "info"]),
      assumptions: z.array(z.string()),
      openQuestions: z.array(
        z.object({
          text: z.string().min(1),
          severity: z.enum(["high", "medium", "low"]),
        }),
      ),
    }),
  ),
});

const monthNames = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const cleaned = value
    .trim()
    .replace(/[₹$€£,\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(cleaned)) return null;
  const result = Number(cleaned);
  return Number.isFinite(result) ? result : null;
}

function periodOrder(value: string): number | null {
  const month = monthNames.findIndex((name) =>
    new RegExp(`^${name}(?:[a-z]*)$`, "i").test(value.trim()),
  );
  if (month >= 0) return month;
  if (/^\d{4}-\d{1,2}$/.test(value.trim())) {
    const [year, monthNumber] = value.trim().split("-").map(Number);
    return year! * 12 + monthNumber! - 1;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function rowGroups(
  rows: readonly number[],
): Array<{ start: number; end: number }> {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const groups: Array<{ start: number; end: number }> = [];
  for (const row of sorted) {
    const previous = groups.at(-1);
    if (previous && row === previous.end + 1) previous.end = row;
    else groups.push({ start: row, end: row });
  }
  return groups.slice(0, 10);
}

function columnName(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function startRow(cellRange: string | undefined): number {
  const match = cellRange?.match(/^[A-Z]+(\d+):/i);
  return match ? Number(match[1]) : 1;
}

function sourceCellRange(
  table: ExtractedTable,
  startColumn: number,
  endColumn: number,
  rows: { start: number; end: number },
): string {
  const firstTableRow = startRow(table.cellRange);
  const first = `${columnName(startColumn)}${firstTableRow + rows.start}`;
  const last = `${columnName(endColumn)}${firstTableRow + rows.end}`;
  return `${first}:${last}`;
}

function classifyDateFormat(value: string): string {
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(value.trim())) return "year-first";
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value.trim())) return "numeric";
  if (/^[a-z]{3,}\s+\d{1,2}(?:,\s*\d{4})?$/i.test(value.trim()))
    return "month-name";
  return "other";
}

function dataQualityIssues(
  rows: readonly (readonly (string | null)[])[],
  headers: readonly string[],
  valueIndex: number,
  periodIndex: number,
  firstSourceRow: number,
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  headers.forEach((header, columnIndex) => {
    const missingRows = rows.flatMap((row, rowIndex) =>
      row[columnIndex] === null || row[columnIndex]?.trim() === ""
        ? [firstSourceRow + rowIndex]
        : [],
    );
    if (missingRows.length) {
      issues.push({
        code: "missing-values",
        severity: missingRows.length > rows.length / 4 ? "medium" : "low",
        message: `${missingRows.length} row(s) have no value in “${header}”.`,
        columns: [header],
        rows: rowGroups(missingRows),
        count: missingRows.length,
      });
    }

    const populated = rows
      .map((row, rowIndex) => ({ value: row[columnIndex], rowIndex }))
      .filter(
        (item): item is { value: string; rowIndex: number } =>
          item.value !== null && item.value.trim() !== "",
      );
    const numericRows = populated.filter(
      (item) => parseNumber(item.value) !== null,
    );
    if (numericRows.length > 0 && numericRows.length < populated.length) {
      issues.push({
        code: "type-mismatch",
        severity: "medium",
        message: `Values in “${header}” mix numeric and non-numeric types.`,
        columns: [header],
        rows: rowGroups(
          populated
            .filter((item) => parseNumber(item.value) === null)
            .map((item) => firstSourceRow + item.rowIndex),
        ),
        count: populated.length - numericRows.length,
      });
    }
  });

  const duplicateRows = new Map<string, number>();
  const repeated: number[] = [];
  rows.forEach((row, rowIndex) => {
    const key = JSON.stringify(row);
    if (duplicateRows.has(key)) repeated.push(firstSourceRow + rowIndex);
    else duplicateRows.set(key, rowIndex);
  });
  if (repeated.length) {
    issues.push({
      code: "duplicate-rows",
      severity: "medium",
      message: `${repeated.length} duplicate row(s) were found.`,
      columns: [...headers],
      rows: rowGroups(repeated),
      count: repeated.length,
    });
  }

  const negativeRows = rows.flatMap((row, rowIndex) => {
    const amount = parseNumber(row[valueIndex]);
    return amount !== null && amount < 0 ? [firstSourceRow + rowIndex] : [];
  });
  if (negativeRows.length) {
    issues.push({
      code: "out-of-range",
      severity: "medium",
      message: `${negativeRows.length} negative value(s) were found in the sales amount column.`,
      columns: [headers[valueIndex]!],
      rows: rowGroups(negativeRows),
      count: negativeRows.length,
    });
  }

  if (periodIndex >= 0) {
    const formats = new Set(
      rows
        .map((row) => row[periodIndex])
        .filter(
          (value): value is string => value !== null && value.trim() !== "",
        )
        .map(classifyDateFormat),
    );
    if (formats.size > 1) {
      const firstFormat = classifyDateFormat(
        rows.find((row) => row[periodIndex]?.trim())![periodIndex]!,
      );
      const inconsistent = rows.flatMap((row, rowIndex) =>
        row[periodIndex]?.trim() &&
        classifyDateFormat(row[periodIndex]) !== firstFormat
          ? [firstSourceRow + rowIndex]
          : [],
      );
      issues.push({
        code: "inconsistent-date-formats",
        severity: "low",
        message: `The period column uses ${formats.size} different date formats.`,
        columns: [headers[periodIndex]!],
        rows: rowGroups(inconsistent),
        count: inconsistent.length,
      });
    }
  }
  return issues;
}

function chooseTable(tables: readonly SourceTable[]): {
  source: SourceTable;
  valueIndex: number;
  periodIndex: number;
  segmentIndex: number;
} {
  const candidates = tables.flatMap((source) => {
    const table = source.table;
    const valueIndex = table.headers
      .map((header, index) => ({ header: normalized(header), index }))
      .filter(({ index }) =>
        table.rows.some((row) => parseNumber(row[index]) !== null),
      )
      .sort((left, right) => {
        const score = (header: string) =>
          /revenue|sales|amount|total|value|price/.test(header) ? 1 : 0;
        return score(right.header) - score(left.header);
      })[0]?.index;
    if (valueIndex === undefined) return [];
    const periodIndex = table.headers.findIndex((header) =>
      /date|month|period|week|quarter|year/.test(normalized(header)),
    );
    let segmentIndex = table.headers.findIndex((header) =>
      /product|category|segment|item|channel|region|brand/.test(
        normalized(header),
      ),
    );
    if (segmentIndex < 0) {
      segmentIndex = table.headers.findIndex(
        (_, index) =>
          index !== valueIndex &&
          index !== periodIndex &&
          new Set(
            table.rows
              .map((row) => row[index]?.trim())
              .filter((value): value is string => Boolean(value)),
          ).size > 1,
      );
    }
    return [{ source, valueIndex, periodIndex, segmentIndex }];
  });
  const candidate = candidates.sort(
    (left, right) =>
      right.source.table.rows.length - left.source.table.rows.length,
  )[0];
  if (!candidate) {
    throw new Error(
      "The uploaded records do not contain a usable numeric sales or amount column.",
    );
  }
  return candidate;
}

function makeSourceEvidence(
  source: SourceTable,
  rowRange: { start: number; end: number },
  columns: readonly string[],
  columnStart = 0,
  columnEnd = Math.max(0, source.table.headers.length - 1),
): EvidenceDraft {
  const sourceRowStart = startRow(source.table.cellRange) + rowRange.start;
  const sourceRowEnd = startRow(source.table.cellRange) + rowRange.end;
  const cellRange = sourceCellRange(
    source.table,
    columnStart,
    columnEnd,
    rowRange,
  );
  return {
    kind: "document",
    sourceRef: `${source.name}:${source.table.id}:${columns.join(",")}:${sourceRowStart}-${sourceRowEnd}`,
    confidence: "high",
    documentId: source.documentId,
    page: null,
    location: {
      ...(source.table.sheet ? { sheet: source.table.sheet } : {}),
      cellRange,
      rowRange: { start: sourceRowStart, end: sourceRowEnd },
      textQuote: `Columns: ${columns.join(", ")}`,
    },
    textQuote: null,
    url: null,
    title: null,
    claim: null,
  };
}

export function analyzeSalesTables(
  tables: readonly SourceTable[],
): DataAnalysisResult {
  const { source, valueIndex, periodIndex, segmentIndex } = chooseTable(tables);
  const table = source.table;
  const firstSourceRow = startRow(table.cellRange) + 1;
  const values = table.rows.map((row) => parseNumber(row[valueIndex]));
  const validValues = values.filter((value): value is number => value !== null);
  if (!validValues.length) {
    throw new Error(
      "No numeric sales values were found in the uploaded records.",
    );
  }

  const byPeriodMap = new Map<string, number>();
  const bySegmentMap = new Map<string, number>();
  table.rows.forEach((row, rowIndex) => {
    const value = values[rowIndex];
    if (value === null) return;
    if (periodIndex >= 0) {
      const label = row[periodIndex]?.trim();
      if (label) byPeriodMap.set(label, (byPeriodMap.get(label) ?? 0) + value);
    }
    if (segmentIndex >= 0) {
      const label = row[segmentIndex]?.trim();
      if (label)
        bySegmentMap.set(label, (bySegmentMap.get(label) ?? 0) + value);
    }
  });

  let byPeriod = [...byPeriodMap.entries()].map(([label, value]) => ({
    label,
    value,
    growthPercent: null as number | null,
  }));
  const orders = byPeriod.map(({ label }) => periodOrder(label));
  if (orders.every((order): order is number => order !== null)) {
    byPeriod = byPeriod
      .map((entry, index) => ({ entry, order: orders[index]! }))
      .sort((left, right) => left.order - right.order)
      .map(({ entry }) => entry);
  }
  byPeriod = byPeriod.map((entry, index) => ({
    ...entry,
    growthPercent:
      index === 0 || byPeriod[index - 1]!.value === 0
        ? null
        : ((entry.value - byPeriod[index - 1]!.value) /
            Math.abs(byPeriod[index - 1]!.value)) *
          100,
  }));
  const bySegment = [...bySegmentMap.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value);
  const total = validValues.reduce((sum, value) => sum + value, 0);
  const metrics = DataAnalysisMetricsSchema.parse({
    rowCount: table.rows.length,
    valueColumn: table.headers[valueIndex]!,
    total,
    average: total / validValues.length,
    periodColumn: periodIndex >= 0 ? table.headers[periodIndex]! : null,
    byPeriod,
    segmentColumn: segmentIndex >= 0 ? table.headers[segmentIndex]! : null,
    bySegment,
    topSegment: bySegment[0] ?? null,
  });
  const dataQuality = dataQualityIssues(
    table.rows,
    table.headers,
    valueIndex,
    periodIndex,
    firstSourceRow,
  );
  const finalSourceRow = Math.max(
    firstSourceRow,
    firstSourceRow + table.rows.length - 1,
  );
  const sourceEvidence = makeSourceEvidence(
    source,
    { start: 1, end: Math.max(1, table.rows.length) },
    table.headers,
  );
  const qualityEvidence = dataQuality.flatMap((issue) =>
    issue.rows.map((rows) =>
      makeSourceEvidence(
        source,
        {
          start: rows.start - firstSourceRow + 1,
          end: rows.end - firstSourceRow + 1,
        },
        issue.columns,
        Math.max(0, table.headers.indexOf(issue.columns[0]!)),
        Math.max(
          0,
          issue.columns.reduce(
            (last, header) => Math.max(last, table.headers.indexOf(header)),
            0,
          ),
        ),
      ),
    ),
  );
  const sourceRange = {
    documentId: source.documentId,
    tableId: table.id,
    sheet: table.sheet ?? null,
    cellRange: table.cellRange ?? null,
    rowRange: { start: firstSourceRow, end: finalSourceRow },
  };
  const dashboardCharts: DataAnalysisDashboard["charts"] = [];
  if (metrics.byPeriod.length) {
    const data = metrics.byPeriod.map(({ label, value }) => ({
      period: label,
      [metrics.valueColumn]: value,
    }));
    dashboardCharts.push({
      id: "sales-by-period",
      title: `${metrics.valueColumn} by ${metrics.periodColumn}`,
      type: "bar",
      categoryKey: "period",
      valueKey: metrics.valueColumn,
      data,
      source: {
        ...sourceRange,
        rowRange: { start: firstSourceRow, end: finalSourceRow },
      },
    });
  }
  if (metrics.byPeriod.length > 1) {
    dashboardCharts.push({
      id: "sales-trend",
      title: `${metrics.valueColumn} trend`,
      type: "line",
      categoryKey: "period",
      valueKey: metrics.valueColumn,
      data: metrics.byPeriod.map(({ label, value }) => ({
        period: label,
        [metrics.valueColumn]: value,
      })),
      source: sourceRange,
    });
  }
  if (metrics.bySegment.length) {
    dashboardCharts.push({
      id: "sales-by-segment",
      title: `${metrics.valueColumn} by ${metrics.segmentColumn}`,
      type: "pie",
      nameKey: "segment",
      valueKey: metrics.valueColumn,
      data: metrics.bySegment.map(({ label, value }) => ({
        segment: label,
        [metrics.valueColumn]: value,
      })),
      source: sourceRange,
    });
  }
  const dashboard = DataAnalysisDashboardSchema.parse({
    charts: dashboardCharts,
  });
  const summary =
    `${metrics.rowCount} row(s) analyzed. ${metrics.valueColumn} total: ` +
    `${total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}; average: ` +
    `${metrics.average.toLocaleString("en-IN", { maximumFractionDigits: 2 })}.`;
  const assumptions: string[] = [];
  const openQuestions: DataAnalysisResult["openQuestions"] = [];
  if (tables.length > 1) {
    assumptions.push(
      `The table with the most rows containing numeric values (${source.name}, ${table.sheet ?? table.id}) was treated as the primary dataset.`,
    );
    openQuestions.push({
      text: "Should the other uploaded tables or workbook sheets be included in this analysis?",
      severity: "low",
    });
  }
  return {
    table: source,
    metrics,
    summary,
    dataQuality,
    dashboard,
    sourceEvidence,
    qualityEvidence,
    assumptions,
    openQuestions,
    sampleRows: table.rows
      .slice(0, 8)
      .map((row) =>
        Object.fromEntries(
          table.headers.map((header, index) => [header, row[index] ?? null]),
        ),
      ),
  };
}

function evidenceForIssue(
  result: DataAnalysisResult,
  issue: DataQualityIssue,
): EvidenceDraft[] {
  const matching = result.qualityEvidence.filter((evidence) =>
    evidence.sourceRef.includes(`:${issue.columns.join(",")}:`),
  );
  return matching.length ? matching : [result.sourceEvidence];
}

function analysisOutput(
  result: DataAnalysisResult,
  narrative: z.infer<typeof NarrativeOutputSchema>,
): SpecialistOutput {
  const periodComponents = result.metrics.byPeriod.map(({ value }) => value);
  const valueComponents =
    periodComponents.reduce((sum, value) => sum + value, 0) ===
    result.metrics.total
      ? periodComponents
      : null;
  const findings = [
    {
      title: "Computed sales metrics",
      description: result.summary,
      severity: "info" as const,
      confidence: 1,
      evidence: [result.sourceEvidence],
      assumptions: [...result.assumptions],
      openQuestions: [...result.openQuestions],
      claims: [
        {
          label: `${result.metrics.valueColumn} total`,
          value: result.metrics.total,
          components: valueComponents,
          date: null,
        },
        {
          label: `${result.metrics.valueColumn} average`,
          value: result.metrics.average,
          components: null,
          date: null,
        },
      ],
    },
    ...narrative.insights.map((insight) => ({
      ...insight,
      confidence: 0.75,
      evidence: [result.sourceEvidence],
      claims: [],
    })),
    ...result.dataQuality.map((issue) => ({
      title: "Data quality: " + issue.code.replaceAll("-", " "),
      description: issue.message,
      severity: issue.severity,
      confidence: 1,
      evidence: evidenceForIssue(result, issue),
      assumptions: [],
      openQuestions: [],
      claims: [],
    })),
  ];
  const report: DataAnalysisReport = DataAnalysisReportSchema.parse({
    summary: result.summary,
    interpretation: narrative.interpretation,
    metrics: result.metrics,
    dataQuality: result.dataQuality,
    assumptions: result.assumptions,
    openQuestions: result.openQuestions,
  });
  return SpecialistOutputSchema.parse({
    summary: narrative.interpretation,
    findings,
    report,
    dashboard: result.dashboard,
    inputRequired: null,
  });
}

export function createBusinessDataAnalystAgent(): SpecialistAgent {
  const systemPrompt = [
    "You are a careful business data analyst.",
    "The numeric metrics and data-quality checks are already computed deterministically.",
    "Interpret only the supplied metrics and sample rows; never recalculate or invent numbers.",
    "Do not claim trends, causes, or anomalies unsupported by the supplied values.",
    "Return concise interpretation, qualitative insights, explicit assumptions, and open questions.",
  ].join("\n");
  return {
    role: BUSINESS_DATA_ANALYST_ROLE,
    modelTier: "mid",
    systemPrompt,
    inputSchema: SpecialistInputSchema,
    outputSchema: SpecialistOutputSchema,
    profile: businessDataAnalystProfile,
    async run(
      input: SpecialistInput,
      context: AgentContext,
    ): Promise<AgentResult<SpecialistOutput>> {
      const sourceTables = await context.documents.tablesAsync();
      const result = analyzeSalesTables(sourceTables);
      const narrativeResult = await context.ai.runStructured({
        tier: "mid",
        inputSchema: NarrativeInputSchema,
        outputSchema: NarrativeOutputSchema,
        system: systemPrompt,
        input: {
          metrics: result.metrics,
          dataQuality: result.dataQuality,
          sampleRows: result.sampleRows,
        },
        usageContext: { ...context.usage, taskId: context.taskId ?? undefined },
        signal: context.signal,
      });
      const output = analysisOutput(result, narrativeResult.output);
      return {
        ...toAgentResult(narrativeResult, "mid"),
        output,
      };
    },
  };
}
