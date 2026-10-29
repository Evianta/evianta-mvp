import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  ShieldCheck,
} from "lucide-react";
import type { SyntheticWorkflowFixture } from "@evianta/core";
import { getSampleMetrics } from "../samples";
import { ConfidenceBadge, StatusBadge } from "./Badges";
import { SampleCopyButton } from "./SampleCopyButton";

export function SampleResult({
  fixture,
}: {
  fixture: SyntheticWorkflowFixture;
}) {
  const metrics = getSampleMetrics(fixture);
  return (
    <div className="reading-column">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        All synthetic samples
      </Link>
      <div className="mt-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="info">Synthetic replay</StatusBadge>
            <StatusBadge>Read-only</StatusBadge>
          </div>
          <h1 className="page-title text-3xl">{fixture.case.title}</h1>
          <p className="page-description text-sm">{fixture.case.description}</p>
        </div>
        <SampleCopyButton caseId={fixture.case.id} />
      </div>

      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {metrics.map((metric) => (
          <div className="surface-card metric-card" key={metric.label}>
            <p className="metric-label">{metric.label}</p>
            <p className="metric-value">{metric.value}</p>
            <p className="metric-caption">{metric.note}</p>
          </div>
        ))}
      </div>

      <section
        className="surface-card mt-6 p-5 sm:p-6"
        aria-labelledby="sample-summary"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="page-eyebrow">Replay summary</p>
            <h2 id="sample-summary" className="mt-2 text-lg font-semibold">
              Findings stay connected to their source
            </h2>
          </div>
          <span className="icon-tile icon-tile-teal hidden sm:inline-grid">
            <ShieldCheck size={20} aria-hidden="true" />
          </span>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          This replay uses deterministic synthetic records. It shows how totals
          are reconciled, assumptions are surfaced, and missing evidence remains
          an open question—not a conclusion.
        </p>
        <div className="mt-5 grid gap-2">
          {fixture.checklist.map((item) => (
            <div
              className="flex items-start gap-3 rounded-lg bg-background px-3 py-3"
              key={item.id}
            >
              <span className="mt-0.5 text-success">
                <Check size={15} aria-hidden="true" />
              </span>
              <span className="text-sm">{item.title}</span>
            </div>
          ))}
        </div>
      </section>

      <section
        className="surface-card mt-5 p-5 sm:p-6"
        aria-labelledby="source-records"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="page-eyebrow">Evidence register</p>
            <h2 id="source-records" className="mt-2 text-lg font-semibold">
              {fixture.documents.length} source records
            </h2>
          </div>
          <ConfidenceBadge confidence={null} />
        </div>
        <div className="mt-4 divide-y divide-border">
          {fixture.documents.map((document, index) => (
            <div className="flex items-center gap-3 py-3" key={document.id}>
              <span className="grid h-8 w-8 place-items-center rounded-md bg-background text-muted-foreground">
                <FileText size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{document.name}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {document.mimeType} · Synthetic source{" "}
                  {String(index + 1).padStart(2, "0")}
                </p>
              </div>
              <StatusBadge tone="success">Ready</StatusBadge>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/[0.045] p-4">
        <div>
          <p className="text-sm font-semibold">
            Need to work with your own records?
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sign in to create a private case. This sample cannot be changed.
          </p>
        </div>
        <Link
          href={`/cases/new?source=${encodeURIComponent(fixture.case.id)}`}
          className="button-link button-link-secondary"
        >
          Try this workflow <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
