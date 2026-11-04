"use client";

import {
  DataAnalysisDashboardSchema,
  DataAnalysisReportSchema,
} from "@evianta/core";
import type { CaseWorkspace } from "../api/client";
import { DashboardCharts, formatNumber } from "./ChartView";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
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
              <dt className="text-xs text-muted-foreground">{label}</dt>
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
          <DashboardCharts charts={dashboard.data.charts} />
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
                <p className="mt-1 text-xs text-muted-foreground">
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
                  <span className="text-xs capitalize text-muted-foreground">
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
                            className="text-left text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
