"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useState } from "react";
import {
  DataAnalysisDashboardSchema,
  DataAnalysisReportSchema,
} from "@evianta/core";
import type { CaseWorkspace } from "../api/client";

const chartColors = [
  "hsl(var(--primary))",
  "hsl(var(--warning))",
  "hsl(199 72% 45%)",
  "hsl(38 78% 53%)",
  "hsl(264 52% 59%)",
];

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
  }).format(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function ChartView({
  chart,
}: {
  chart: ReturnType<typeof DataAnalysisDashboardSchema.parse>["charts"][number];
}) {
  const [dataPage, setDataPage] = useState(0);
  const [showData, setShowData] = useState(false);
  const axisClass = "fill-muted-foreground text-[10px]";
  const labelKey = chart.type === "pie" ? chart.nameKey : chart.categoryKey;
  const pageSize = 100;
  const pageCount = Math.ceil(chart.data.length / pageSize);
  const pageRows = chart.data.slice(
    dataPage * pageSize,
    (dataPage + 1) * pageSize,
  );
  const firstRow = dataPage * pageSize + 1;
  const lastRow = Math.min((dataPage + 1) * pageSize, chart.data.length);
  return (
    <figure className="rounded-lg border border-border bg-background p-4">
      <figcaption className="mb-3 text-xs font-semibold">
        {chart.title}
      </figcaption>
      <div className="h-64 w-full" role="img" aria-label={chart.title}>
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === "bar" ? (
            <BarChart data={chart.data}>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey={chart.categoryKey}
                tick={{ className: axisClass }}
              />
              <YAxis tick={{ className: axisClass }} />
              <Tooltip />
              <Bar
                dataKey={chart.valueKey}
                fill={chartColors[0]}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          ) : chart.type === "line" ? (
            <LineChart data={chart.data}>
              <CartesianGrid
                stroke="hsl(var(--border))"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey={chart.categoryKey}
                tick={{ className: axisClass }}
              />
              <YAxis tick={{ className: axisClass }} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey={chart.valueKey}
                stroke={chartColors[0]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          ) : (
            <PieChart>
              <Tooltip />
              <Pie
                data={chart.data}
                dataKey={chart.valueKey}
                nameKey={chart.nameKey}
                outerRadius="80%"
                label
              >
                {chart.data.map((entry, index) => (
                  <Cell
                    key={String(entry[chart.nameKey] ?? index)}
                    fill={chartColors[index % chartColors.length]}
                  />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
      <details
        className="mt-3 text-xs"
        onToggle={(event) => setShowData(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-muted-foreground">
          View chart data
        </summary>
        {showData && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">{chart.title} data</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {labelKey}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {chart.valueKey}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((entry, index) => {
                  const label = entry[labelKey];
                  const value = entry[chart.valueKey];
                  return (
                    <tr
                      className="border-b border-border/50"
                      key={`${String(label ?? "")}-${firstRow + index}`}
                    >
                      <th scope="row" className="py-1 pr-3 font-normal">
                        {String(label ?? "Unknown")}
                      </th>
                      <td className="py-1 text-right">
                        {typeof value === "number"
                          ? formatNumber(value)
                          : String(value ?? "—")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pageCount > 1 && (
              <div className="mt-2 flex items-center justify-between gap-3">
                <p aria-live="polite" className="text-muted-foreground">
                  Rows {firstRow}–{lastRow} of {chart.data.length}
                </p>
                <div className="flex gap-2">
                  <button
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                    disabled={dataPage === 0}
                    onClick={() => setDataPage((page) => page - 1)}
                    type="button"
                  >
                    Previous
                  </button>
                  <button
                    className="rounded border border-border px-2 py-1 disabled:opacity-50"
                    disabled={dataPage + 1 >= pageCount}
                    onClick={() => setDataPage((page) => page + 1)}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </details>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Source: {chart.source.documentId}
        {chart.source.sheet ? ` · ${chart.source.sheet}` : ""}
        {chart.source.cellRange ? ` · ${chart.source.cellRange}` : ""}
        {" · rows "}
        {chart.source.rowRange.start}–{chart.source.rowRange.end}
      </p>
    </figure>
  );
}

export function DataAnalysisResults({
  workspace,
  onOpenEvidence,
}: {
  workspace: CaseWorkspace | null;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const deliverable = workspace?.deliverables
    .filter((item) => item.format === "dashboard")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const section = deliverable?.sections.find((item) => {
    const content = asRecord(item.content);
    return content?.report !== undefined || content?.dashboard !== undefined;
  });
  const content = section ? asRecord(section.content) : null;
  const report = DataAnalysisReportSchema.safeParse(content?.report);
  const dashboard = DataAnalysisDashboardSchema.safeParse(content?.dashboard);

  if (!workspace?.documents.length) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border p-4">
        <p className="text-xs font-medium">Add a sales dataset to begin</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Upload a CSV or Excel workbook. The analysis will report exact
          computed metrics, data-quality checks, and source-linked charts here.
        </p>
      </div>
    );
  }

  if (!report.success || !dashboard.success) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-border p-4">
        <p className="text-xs font-medium">
          {deliverable
            ? "This run has no data-analysis report."
            : "No report is available yet"}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Start an analysis after the uploaded dataset is ready. Completed
          reports and chart specifications are loaded from the private API.
        </p>
      </div>
    );
  }

  const { metrics } = report.data;
  const latestSectionFindings = new Set(section?.findingIds ?? []);
  const findings = workspace.findings.filter((finding) =>
    latestSectionFindings.has(finding.id),
  );
  const evidenceById = new Map(
    workspace.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const documentsById = new Map(
    workspace.documents.map((document) => [document.id, document]),
  );

  return (
    <div className="mt-5 space-y-5">
      <section className="rounded-lg border border-border bg-background p-4">
        <h3 className="text-xs font-semibold">Executive summary</h3>
        <p className="mt-2 text-xs leading-relaxed">
          {typeof section?.reviewerContent === "string"
            ? section.reviewerContent
            : report.data.summary}
        </p>
        {report.data.interpretation && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {report.data.interpretation}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Rows analyzed", formatNumber(metrics.rowCount)],
            [`${metrics.valueColumn} total`, formatNumber(metrics.total)],
            [`${metrics.valueColumn} average`, formatNumber(metrics.average)],
            [
              metrics.topSegment
                ? `Top ${metrics.segmentColumn ?? "segment"}`
                : "Period groups",
              metrics.topSegment?.label ??
                formatNumber(metrics.byPeriod.length),
            ],
          ].map(([label, value]) => (
            <div className="rounded-md bg-muted/10 p-3" key={label}>
              <dt className="text-[10px] text-muted-foreground">{label}</dt>
              <dd className="mono-number mt-1 text-sm font-semibold">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="data-charts-heading">
        <h3 id="data-charts-heading" className="mb-3 text-xs font-semibold">
          Dashboard
        </h3>
        {dashboard.data.charts.length ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {dashboard.data.charts.map((chart) => (
              <ChartView key={chart.id} chart={chart} />
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
            No chartable period or segment columns were found in this dataset.
          </p>
        )}
      </section>

      {report.data.dataQuality.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold">
            Data-quality checks ({report.data.dataQuality.length})
          </h3>
          <ul className="space-y-2">
            {report.data.dataQuality.map((issue, index) => (
              <li
                className="rounded-lg border border-warning/20 bg-warning/[0.04] p-3 text-xs"
                key={`${issue.code}-${index}`}
              >
                <p className="font-medium">{issue.message}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {issue.columns.join(", ")} · {issue.count} affected row(s)
                  {issue.rows.length
                    ? ` · source row(s) ${issue.rows.map((range) => (range.start === range.end ? range.start : `${range.start}–${range.end}`)).join(", ")}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {findings.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold">Findings and evidence</h3>
          <ul className="space-y-3">
            {findings.map((finding) => (
              <li
                className="rounded-lg border border-border bg-background p-3"
                key={finding.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-xs font-semibold">{finding.title}</h4>
                  <span className="text-[10px] capitalize text-muted-foreground">
                    {finding.severity}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed">
                  {finding.description}
                </p>
                {finding.evidenceIds.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {finding.evidenceIds.map((id) => {
                      const source = evidenceById.get(id);
                      if (!source || source.kind !== "document") return null;
                      const document = documentsById.get(source.documentId);
                      const location = source.location;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            className="text-left text-[10px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                            onClick={() => onOpenEvidence(source.id)}
                          >
                            Evidence: {document?.name ?? source.documentId}
                            {location.sheet ? ` · ${location.sheet}` : ""}
                            {location.cellRange
                              ? ` · ${location.cellRange}`
                              : ""}
                            {location.rowRange
                              ? ` · rows ${location.rowRange.start}–${location.rowRange.end}`
                              : ""}
                            {location.page ? ` · page ${location.page}` : ""}
                            {location.textQuote
                              ? ` · ${location.textQuote}`
                              : ""}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.data.assumptions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold">Assumptions</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {report.data.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </section>
      )}

      {report.data.openQuestions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold">Open questions</h3>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {report.data.openQuestions.map((question, index) => (
              <li key={`${question.severity}-${index}`}>
                {question.text} ({question.severity})
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
